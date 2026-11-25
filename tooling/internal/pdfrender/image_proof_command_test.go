//go:build linux

package pdfrender

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	// Separate helper and grandchild start-up from the cancellation deadline so
	// host load during process launch cannot consume the cancellation window;
	// start-up and cancellation are independent bounds (issue 555).
	heldPipeStartBound     = 10 * time.Second
	heldPipeCancelDeadline = 200 * time.Millisecond
	heldPipePollInterval   = 5 * time.Millisecond
	heldPipeStartAttempts  = int(heldPipeStartBound / heldPipePollInterval)
)

func TestImageProofSubprocessBoundaries(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"valid", "nonzero", "stderr-overflow", "malformed", "silent"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			command := exec.Command(os.Args[0], "-test.run=^TestImageProofProcessHelper$")
			command.Env = append(os.Environ(), "PDF_PROOF_HELPER="+mode)
			deadline := 2 * time.Second
			if mode == "silent" {
				deadline = 200 * time.Millisecond
			}
			started := time.Now()
			proof, err := inspectImageProofCommand(context.Background(), command, testManifestDigest, testManifestDigest, deadline)
			if mode == "valid" {
				if err != nil || digestBytes(proof.Config) != testProofConfigDigest {
					t.Fatalf("valid subprocess: %+v %v", proof, err)
				}
			} else if err == nil || len(proof.Config) != 0 || len(proof.Manifest) != 0 {
				t.Fatalf("failed subprocess emitted successful proof: %+v %v", proof, err)
			}
			if time.Since(started) > 4*time.Second {
				t.Fatal("subprocess exceeded bounded cancellation margin")
			}
		})
	}
}

type heldPipeWatchResult struct {
	started     bool
	cancelledAt time.Time
}

func TestImageProofHeldPipeCancellation(t *testing.T) {
	t.Parallel()
	markerRoot := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestImageProofProcessHelper$")
	command.Env = append(os.Environ(),
		"PDF_PROOF_HELPER=held-pipe",
		"PDF_PROOF_MARKER_ROOT="+markerRoot,
	)
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	watched := make(chan heldPipeWatchResult, 1)
	go watchHeldPipeStart(parent, cancel, filepath.Join(markerRoot, "started"), watched)

	// Timeout acts only as an upper-bound backstop if cancellation fails.
	proof, err := inspectImageProofCommand(parent, command, testManifestDigest, testManifestDigest, heldPipeStartBound+2*time.Second)
	returnedAt := time.Now()
	cancel()
	result := <-watched

	if err == nil || len(proof.Config) != 0 || len(proof.Manifest) != 0 {
		t.Fatalf("failed subprocess emitted successful proof: %+v %v", proof, err)
	}
	if !result.started {
		t.Fatal("helper did not confirm the grandchild started within the start-up bound")
	}
	if _, err := os.Stat(filepath.Join(markerRoot, "ready")); err != nil {
		t.Fatal("grandchild did not confirm it was running before cancellation")
	}
	if returnedAt.Sub(result.cancelledAt) > 4*time.Second {
		t.Fatal("subprocess exceeded bounded cancellation margin")
	}
	// The child writes this marker after 800 ms if it survived. A
	// pipe-close-only cancellation therefore fails this assertion.
	time.Sleep(time.Second)
	if _, err := os.Stat(filepath.Join(markerRoot, "survived")); !os.IsNotExist(err) {
		t.Fatal("owned descendant survived process-group cancellation")
	}
}

func watchHeldPipeStart(parent context.Context, cancel context.CancelFunc, startedPath string, watched chan<- heldPipeWatchResult) {
	seen := waitForProofMarker(parent, startedPath)
	if seen {
		timer := time.NewTimer(heldPipeCancelDeadline)
		select {
		case <-parent.Done():
		case <-timer.C:
		}
		timer.Stop()
	}
	watched <- heldPipeWatchResult{started: seen, cancelledAt: time.Now()}
	cancel()
}

func waitForProofMarker(parent context.Context, path string) bool {
	ctx, cancel := context.WithTimeout(parent, heldPipeStartBound)
	defer cancel()
	ticker := time.NewTicker(heldPipePollInterval)
	defer ticker.Stop()
	for attempt := 0; attempt < heldPipeStartAttempts; attempt++ {
		if hasProofMarker(parent, path) {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		select {
		case <-ctx.Done():
			return hasProofMarker(parent, path)
		case <-ticker.C:
		}
	}
	return hasProofMarker(parent, path)
}

func hasProofMarker(ctx context.Context, path string) bool {
	if ctx.Err() != nil {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func TestImageProofCancelledBeforeStart(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	command := exec.Command("/not/a/command")
	if _, err := inspectImageProofCommand(ctx, command, testManifestDigest, testManifestDigest, time.Second); err == nil || command.Process != nil {
		t.Fatal("cancelled proof started subprocess")
	}
}

func TestImageProofProcessHelper(t *testing.T) {
	mode := os.Getenv("PDF_PROOF_HELPER")
	if mode == "" {
		return
	}
	switch mode {
	case "child":
		runChildHelper(os.Getenv("PDF_PROOF_MARKER_ROOT"))
	case "held-pipe":
		runHeldPipeHelper(os.Getenv("PDF_PROOF_MARKER_ROOT"))
	case "silent":
		time.Sleep(10 * time.Second)
		os.Exit(0)
	case "malformed":
		_, _ = os.Stdout.Write([]byte(strings.Repeat("!", 512)))
		time.Sleep(3 * time.Second)
		os.Exit(0)
	case "stderr-overflow":
		_, _ = os.Stderr.Write([]byte(strings.Repeat("!", maximumDiagnosticBytes+1)))
	case "valid", "nonzero":
	default:
		os.Exit(9)
	}
	_, _ = os.Stdout.Write(testImageProofTar(testImageProofFiles(true)))
	if mode == "nonzero" {
		os.Exit(7)
	}
	os.Exit(0)
}

func runChildHelper(root string) {
	if err := os.WriteFile(filepath.Join(root, "ready"), []byte("ready"), 0o600); err != nil {
		os.Exit(10)
	}
	time.Sleep(800 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(root, "survived"), []byte("survived"), 0o600); err != nil {
		os.Exit(11)
	}
	os.Exit(0)
}

func runHeldPipeHelper(root string) {
	command := exec.Command(os.Args[0], "-test.run=^TestImageProofProcessHelper$")
	command.Env = append(os.Environ(), "PDF_PROOF_HELPER=child")
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Start(); err != nil {
		os.Exit(8)
	}
	if !waitForProofMarker(context.Background(), filepath.Join(root, "ready")) {
		os.Exit(12)
	}
	if err := os.WriteFile(filepath.Join(root, "started"), []byte("started"), 0o600); err != nil {
		os.Exit(13)
	}
	os.Exit(0)
}

func TestReproducibilityDockerRoutingIsPinnedAndSanitised(t *testing.T) {
	for _, name := range []string{"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "BUILDX_BUILDER", "BUILDKIT_HOST", "DOCKER_TLS_VERIFY"} {
		t.Setenv(name, "must-not-reach-command")
	}
	environment := reproducibilityDockerEnvironment()
	for _, value := range environment {
		if strings.Contains(value, "must-not-reach-command") {
			t.Fatalf("retained routing override %q", value)
		}
	}
	arguments := []string{"image", "save", "image"}
	pinned := pinnedReproducibilityArguments(arguments)
	if !slices.Equal(pinned, []string{"--host", reproducibilityDockerEndpoint, "image", "save", "image"}) || len(arguments) != 3 {
		t.Fatalf("pinned arguments=%v original=%v", pinned, arguments)
	}
}

func TestImageProofFailedStartAndTimeoutValidation(t *testing.T) {
	t.Parallel()
	command := exec.Command(filepath.Join(t.TempDir(), "missing-command"))
	if _, err := inspectImageProofCommand(context.Background(), command, testManifestDigest, testManifestDigest, time.Second); err == nil {
		t.Fatal("accepted failed start")
	}
	for _, timeout := range []time.Duration{0, -1, 121 * time.Second} {
		t.Run(fmt.Sprint(timeout), func(t *testing.T) {
			command := exec.Command("/not/a/command")
			if _, err := inspectImageProofCommand(context.Background(), command, testManifestDigest, testManifestDigest, timeout); err == nil || command.Process != nil {
				t.Fatal("accepted invalid timeout")
			}
		})
	}
}
