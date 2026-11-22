package githubmilestones

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func testManifest(count int) Manifest {
	milestones := make([]Milestone, 0, count)
	for index := 0; index < count; index++ {
		id := fmt.Sprintf("M%d", index)
		milestones = append(milestones, Milestone{
			ID:      id,
			Title:   fmt.Sprintf("%s — Test stage %d", id, index),
			State:   "open",
			Roadmap: fmt.Sprintf("concept/90-research-roadmap.md#stage-%d--test-stage-%d", index, index),
			Summary: fmt.Sprintf("Exercise deterministic milestone synchronization for test stage %d.", index),
		})
	}
	return Manifest{Schema: 1, Milestones: milestones}
}

func pointer(value string) *string { return &value }

func writeRemoteMilestone(t *testing.T, writer http.ResponseWriter, state remoteMilestone, status int) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(state); err != nil {
		t.Fatal(err)
	}
}

func TestSyncCreatesUpdatesAndPreservesUnmanagedMilestones(t *testing.T) {
	t.Parallel()
	manifest := testManifest(3)
	options := Options{Repository: "owner/repository", Token: "test-token"}
	currentDescription := managedDescription(options.Repository, manifest.Milestones[0])
	oldDescription := "<!-- 20w-roadmap-id:M1 -->\nOld projection"
	unmanagedDescription := "A human-managed release target"
	var mutex sync.Mutex
	requests := make([]string, 0, 6)
	remote := []remoteMilestone{
		{Number: 1, State: "open", Title: manifest.Milestones[0].Title, Description: &currentDescription},
		{Number: 2, State: "closed", Title: "M1 — Old title", Description: &oldDescription},
		{Number: 99, State: "open", Title: "Unmanaged release", Description: &unmanagedDescription},
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		requests = append(requests, request.Method+" "+request.URL.RequestURI())
		if request.Header.Get("Authorization") != "Bearer test-token" ||
			request.Header.Get("X-GitHub-Api-Version") != apiVersion {
			http.Error(writer, "missing identity headers", http.StatusUnauthorized)
			return
		}
		switch request.Method + " " + request.URL.Path {
		case "GET /repos/owner/repository/milestones":
			if request.URL.Query().Get("state") != "all" || request.URL.Query().Get("per_page") != "100" || request.URL.Query().Get("page") != "1" {
				http.Error(writer, "bad pagination", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(writer).Encode(remote)
		case "PATCH /repos/owner/repository/milestones/2":
			description := managedDescription(options.Repository, manifest.Milestones[1])
			state := remoteMilestone{
				Number: 2, State: "open", Title: manifest.Milestones[1].Title, Description: &description,
			}
			remote[1] = state
			writeRemoteMilestone(t, writer, state, http.StatusOK)
		case "POST /repos/owner/repository/milestones":
			description := managedDescription(options.Repository, manifest.Milestones[2])
			state := remoteMilestone{
				Number: 3, State: "open", Title: manifest.Milestones[2].Title, Description: &description,
			}
			remote = append(remote, state)
			writeRemoteMilestone(t, writer, state, http.StatusCreated)
		default:
			http.Error(writer, "unexpected request", http.StatusBadRequest)
		}
	}))
	defer server.Close()
	options.APIBase = server.URL

	result, err := Sync(context.Background(), server.Client(), manifest, options)
	if err != nil {
		t.Fatal(err)
	}
	if result != (Result{Created: 1, Updated: 1, Unchanged: 1}) {
		t.Fatalf("Sync() = %#v", result)
	}
	second, err := Sync(context.Background(), server.Client(), manifest, options)
	if err != nil || second != (Result{Unchanged: 3}) {
		t.Fatalf("idempotent Sync() = %#v, %v", second, err)
	}
	if len(requests) != 6 || remote[2].Title != "Unmanaged release" {
		t.Fatalf("requests = %#v", requests)
	}
}

func TestSyncRejectsManagedIdentityDriftAndDueDates(t *testing.T) {
	t.Parallel()
	manifest := testManifest(1)
	validDescription := managedDescription("owner/repository", manifest.Milestones[0])
	for name, remote := range map[string][]remoteMilestone{
		"duplicate": {
			{Number: 1, State: "open", Title: "one", Description: &validDescription},
			{Number: 2, State: "open", Title: "two", Description: &validDescription},
		},
		"unknown":                  {{Number: 1, State: "open", Title: "unknown", Description: pointer("<!-- 20w-roadmap-id:M1 -->")}},
		"malformed":                {{Number: 1, State: "open", Title: "malformed", Description: pointer("<!-- 20w-roadmap-id:M0-->")}},
		"unmarked title collision": {{Number: 1, State: "open", Title: manifest.Milestones[0].Title}},
		"due date":                 {{Number: 1, State: "open", Title: manifest.Milestones[0].Title, Description: &validDescription, DueOn: pointer("2030-01-01T00:00:00Z")}},
	} {
		name, remote := name, remote
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(writer).Encode(remote)
			}))
			defer server.Close()
			_, err := Sync(context.Background(), server.Client(), manifest, Options{
				APIBase: server.URL, Repository: "owner/repository", Token: "token",
			})
			if err == nil {
				t.Fatalf("Sync() accepted %s", name)
			}
		})
	}
}

func TestSyncPreflightsDueDatesBeforeCreatingMissingMilestones(t *testing.T) {
	t.Parallel()
	manifest := testManifest(2)
	description := managedDescription("owner/repository", manifest.Milestones[1])
	mutations := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			mutations++
		}
		_ = json.NewEncoder(writer).Encode([]remoteMilestone{{
			Number: 2, State: "open", Title: manifest.Milestones[1].Title,
			Description: &description, DueOn: pointer("2030-01-01T00:00:00Z"),
		}})
	}))
	defer server.Close()
	_, err := Sync(context.Background(), server.Client(), manifest, Options{
		APIBase: server.URL, Repository: "owner/repository", Token: "token",
	})
	if err == nil || mutations != 0 {
		t.Fatalf("Sync() error/mutations = %v/%d, want due-date preflight before mutation", err, mutations)
	}
}

func TestSyncRejectsMutationResponseWithDueDate(t *testing.T) {
	t.Parallel()
	manifest := testManifest(1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet {
			_ = json.NewEncoder(writer).Encode([]remoteMilestone{})
			return
		}
		description := managedDescription("owner/repository", manifest.Milestones[0])
		writeRemoteMilestone(t, writer, remoteMilestone{
			Number: 1, State: "open", Title: manifest.Milestones[0].Title,
			Description: &description, DueOn: pointer("2030-01-01T00:00:00Z"),
		}, http.StatusCreated)
	}))
	defer server.Close()
	_, err := Sync(context.Background(), server.Client(), manifest, Options{
		APIBase: server.URL, Repository: "owner/repository", Token: "token",
	})
	if err == nil || !strings.Contains(err.Error(), "response identity") {
		t.Fatalf("Sync() error = %v, want due-date response refusal", err)
	}
}

func TestSyncRejectsRemoteInventoryBeyondBound(t *testing.T) {
	t.Parallel()
	manifest := testManifest(1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		page := request.URL.Query().Get("page")
		milestones := make([]remoteMilestone, remoteMilestonesPerPage)
		for index := range milestones {
			number := (int(page[0]-'0')-1)*remoteMilestonesPerPage + index + 1
			milestones[index] = remoteMilestone{Number: number, State: "open", Title: fmt.Sprintf("unmanaged-%d", number)}
		}
		_ = json.NewEncoder(writer).Encode(milestones)
	}))
	defer server.Close()
	_, err := Sync(context.Background(), server.Client(), manifest, Options{
		APIBase: server.URL, Repository: "owner/repository", Token: "token",
	})
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("Sync() error = %v, want bounded-inventory rejection", err)
	}
}

func TestSyncRejectsMissingAuthorityAndInvalidAPIBase(t *testing.T) {
	t.Parallel()
	manifest := testManifest(1)
	if _, err := Sync(context.Background(), http.DefaultClient, manifest, Options{}); err == nil {
		t.Fatal("Sync() accepted missing repository and token authority")
	}
	if _, err := Sync(context.Background(), http.DefaultClient, manifest, Options{
		APIBase: "not a URL", Repository: "owner/repository", Token: "token",
	}); err == nil {
		t.Fatal("Sync() accepted an invalid API base")
	}
}

func TestVerifyNamesDriftedFields(t *testing.T) {
	t.Parallel()
	manifest := testManifest(1)
	milestone := manifest.Milestones[0]
	validDescription := managedDescription("owner/repository", milestone)
	oldOwnerDescription := managedDescription("old/repository", milestone)
	matching := []remoteMilestone{{
		Number: 7, State: milestone.State, Title: milestone.Title, Description: &validDescription,
	}}
	cases := []struct {
		name      string
		remote    []remoteMilestone
		wantDrift string
	}{
		{name: "matching", remote: matching},
		{
			name: "old owner description",
			remote: []remoteMilestone{{
				Number: 7, State: milestone.State, Title: milestone.Title, Description: &oldOwnerDescription,
			}},
			wantDrift: "description",
		},
		{
			name: "title and state drift",
			remote: []remoteMilestone{{
				Number: 7, State: "closed", Title: "M0 — Drifted title", Description: &validDescription,
			}},
			wantDrift: "title, state",
		},
		{name: "missing managed milestone", remote: []remoteMilestone{}, wantDrift: "missing"},
		{
			name: "due_on set",
			remote: []remoteMilestone{{
				Number: 7, State: milestone.State, Title: milestone.Title,
				Description: &validDescription, DueOn: pointer("2030-01-01T00:00:00Z"),
			}},
			wantDrift: "due_on",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			runVerifyDriftCase(t, manifest, matching, tc.remote, tc.wantDrift)
		})
	}
}

func runVerifyDriftCase(
	t *testing.T,
	manifest Manifest,
	matching []remoteMilestone,
	verifyRemote []remoteMilestone,
	wantDrift string,
) {
	t.Helper()
	var mutex sync.Mutex
	current := matching
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		_ = json.NewEncoder(writer).Encode(current)
	}))
	defer server.Close()
	options := Options{APIBase: server.URL, Repository: "owner/repository", Token: "test-token"}
	plan, err := Preflight(context.Background(), server.Client(), manifest, options)
	if err != nil {
		t.Fatalf("Preflight() error = %v", err)
	}
	mutex.Lock()
	current = verifyRemote
	mutex.Unlock()
	inventory, err := plan.Verify(context.Background(), server.Client(), options)
	assertVerifyOutcome(t, inventory, err, matching[0].Number, wantDrift)
}

func assertVerifyOutcome(t *testing.T, inventory Inventory, err error, wantNumber int, wantDrift string) {
	t.Helper()
	if wantDrift == "" {
		if err != nil {
			t.Fatalf("Verify() error = %v, want nil", err)
		}
		if number, ok := inventory.Number("M0"); !ok || number != wantNumber {
			t.Fatalf("inventory.Number(M0) = %d, %v, want %d, true", number, ok, wantNumber)
		}
		return
	}
	if err == nil {
		t.Fatalf("Verify() error = nil, want %q drift", wantDrift)
	}
	message := err.Error()
	if !strings.Contains(message, wantDrift) || !strings.Contains(message, "sync-metadata") ||
		strings.Contains(message, "after synchronization") {
		t.Fatalf("Verify() error = %q, want %q and sync-metadata without after synchronization", message, wantDrift)
	}
	wantDueOnHint := strings.Contains(wantDrift, "due_on")
	hasDueOnHint := strings.Contains(message, "remove its due date")
	if wantDueOnHint != hasDueOnHint {
		t.Fatalf("Verify() error = %q, want remove its due date hint=%v", message, wantDueOnHint)
	}
}
