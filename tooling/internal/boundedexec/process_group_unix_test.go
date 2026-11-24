//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package boundedexec

import (
	"errors"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

const testPGID = 4242

type killCall struct {
	pid    int
	signal syscall.Signal
}

type killProcessGroupCase struct {
	name       string
	pgid       int
	results    []error
	clockStep  time.Duration
	wantCalls  []killCall
	wantPauses int
	wantErr    error
	forbidErr  error
	wantSubstr string
}

type fakeProcessSystem struct {
	t         *testing.T
	results   []error
	clock     time.Time
	clockStep time.Duration
	calls     []killCall
	pauses    int
}

func newFakeProcessSystem(t *testing.T, results []error, clockStep time.Duration) *fakeProcessSystem {
	t.Helper()
	if clockStep == 0 {
		clockStep = pollInterval
	}
	return &fakeProcessSystem{
		t:         t,
		results:   results,
		clock:     time.Unix(1_700_000_000, 0),
		clockStep: clockStep,
	}
}

func (fake *fakeProcessSystem) killer() processGroupKiller {
	return processGroupKiller{
		kill:  fake.kill,
		pause: fake.pause,
		now:   fake.now,
	}
}

func (fake *fakeProcessSystem) kill(pid int, signal syscall.Signal) error {
	index := len(fake.calls)
	fake.calls = append(fake.calls, killCall{pid: pid, signal: signal})
	if index >= len(fake.results) {
		fake.t.Fatalf("unexpected kill call #%d (%d, %v)", index+1, pid, signal)
	}
	return fake.results[index]
}

func (fake *fakeProcessSystem) pause(duration time.Duration) {
	if duration != pollInterval {
		fake.t.Fatalf("pause(%s), want %s", duration, pollInterval)
	}
	fake.pauses++
	fake.clock = fake.clock.Add(fake.clockStep)
}

func (fake *fakeProcessSystem) now() time.Time {
	return fake.clock
}

func repeatError(err error, count int) []error {
	out := make([]error, count)
	for index := 0; index < count; index++ {
		out[index] = err
	}
	return out
}

func sigkillPlusProbes(pgid int, probes int) []killCall {
	calls := make([]killCall, 0, 1+probes)
	calls = append(calls, killCall{pid: -pgid, signal: syscall.SIGKILL})
	for index := 0; index < probes; index++ {
		calls = append(calls, killCall{pid: -pgid, signal: 0})
	}
	return calls
}

func TestKillProcessGroup(t *testing.T) {
	t.Parallel()
	cases := slices.Concat(
		immediateAndSettledCases(),
		exhaustionAndProbeErrorCases(),
		rekillAndBoundaryCases(),
	)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			runKillProcessGroupCase(t, tc)
		})
	}
}

func runKillProcessGroupCase(t *testing.T, tc killProcessGroupCase) {
	t.Helper()
	fake := newFakeProcessSystem(t, tc.results, tc.clockStep)
	err := fake.killer().killProcessGroup(tc.pgid)
	assertKillError(t, tc.pgid, err, tc)
	if !slices.Equal(fake.calls, tc.wantCalls) {
		t.Fatalf("calls = %v, want %v", fake.calls, tc.wantCalls)
	}
	if fake.pauses != tc.wantPauses {
		t.Fatalf("pauses = %d, want %d", fake.pauses, tc.wantPauses)
	}
}

func assertKillError(t *testing.T, pgid int, err error, tc killProcessGroupCase) {
	t.Helper()
	if tc.wantErr == nil {
		if err != nil {
			t.Fatalf("killProcessGroup(%d) error = %v, want nil", pgid, err)
		}
		return
	}
	if !errors.Is(err, tc.wantErr) {
		t.Fatalf("killProcessGroup(%d) error = %v, want errors.Is(_, %v)", pgid, err, tc.wantErr)
	}
	if tc.forbidErr != nil && errors.Is(err, tc.forbidErr) {
		t.Fatalf("killProcessGroup(%d) error = %v, must not match %v", pgid, err, tc.forbidErr)
	}
	if tc.wantSubstr != "" && !strings.Contains(err.Error(), tc.wantSubstr) {
		t.Fatalf("killProcessGroup(%d) error = %q, want substring %q", pgid, err.Error(), tc.wantSubstr)
	}
}

func immediateAndSettledCases() []killProcessGroupCase {
	return []killProcessGroupCase{
		{
			name:      "sigkill_nil",
			pgid:      testPGID,
			results:   []error{nil},
			wantCalls: []killCall{{pid: -testPGID, signal: syscall.SIGKILL}},
		},
		{
			name:      "sigkill_esrch_no_probe",
			pgid:      testPGID,
			results:   []error{syscall.ESRCH},
			wantCalls: []killCall{{pid: -testPGID, signal: syscall.SIGKILL}},
			wantErr:   syscall.ESRCH,
		},
		{
			name:      "sigkill_einval_no_probe",
			pgid:      testPGID,
			results:   []error{syscall.EINVAL},
			wantCalls: []killCall{{pid: -testPGID, signal: syscall.SIGKILL}},
			wantErr:   syscall.EINVAL,
		},
		{
			name:      "eperm_then_probe_esrch",
			pgid:      testPGID,
			results:   []error{syscall.EPERM, syscall.ESRCH},
			wantCalls: sigkillPlusProbes(testPGID, 1),
			wantErr:   syscall.ESRCH,
			forbidErr: syscall.EPERM,
		},
		{
			name:       "eperm_three_probes_then_esrch",
			pgid:       testPGID,
			results:    []error{syscall.EPERM, syscall.EPERM, syscall.EPERM, syscall.EPERM, syscall.ESRCH},
			wantCalls:  sigkillPlusProbes(testPGID, 4),
			wantPauses: 3,
			wantErr:    syscall.ESRCH,
			forbidErr:  syscall.EPERM,
		},
	}
}

func exhaustionAndProbeErrorCases() []killProcessGroupCase {
	return []killProcessGroupCase{
		{
			name:       "lasting_eperm_hits_max_probes",
			pgid:       testPGID,
			results:    repeatError(syscall.EPERM, 1+maxProbes),
			wantCalls:  sigkillPlusProbes(testPGID, maxProbes),
			wantPauses: maxProbes - 1,
			wantErr:    syscall.EPERM,
			forbidErr:  syscall.ESRCH,
			wantSubstr: "process group 4242 still refuses SIGKILL after",
		},
		{
			name:       "lasting_eperm_hits_settle_deadline",
			pgid:       testPGID,
			results:    repeatError(syscall.EPERM, 4),
			clockStep:  time.Second,
			wantCalls:  sigkillPlusProbes(testPGID, 3),
			wantPauses: 2,
			wantErr:    syscall.EPERM,
			forbidErr:  syscall.ESRCH,
			wantSubstr: "process group 4242 still refuses SIGKILL after 2s",
		},
		{
			name:       "probe_eio_wrapped_with_pgid",
			pgid:       testPGID,
			results:    []error{syscall.EPERM, syscall.EIO},
			wantCalls:  sigkillPlusProbes(testPGID, 1),
			wantErr:    syscall.EIO,
			forbidErr:  syscall.EPERM,
			wantSubstr: "4242",
		},
	}
}

func rekillAndBoundaryCases() []killProcessGroupCase {
	rekill := []killCall{
		{pid: -testPGID, signal: syscall.SIGKILL},
		{pid: -testPGID, signal: 0},
		{pid: -testPGID, signal: syscall.SIGKILL},
	}
	return []killProcessGroupCase{
		{
			name:      "eperm_probe_visible_rekill_nil",
			pgid:      testPGID,
			results:   []error{syscall.EPERM, nil, nil},
			wantCalls: rekill,
		},
		{
			name:      "eperm_probe_visible_rekill_esrch",
			pgid:      testPGID,
			results:   []error{syscall.EPERM, nil, syscall.ESRCH},
			wantCalls: rekill,
			wantErr:   syscall.ESRCH,
			forbidErr: syscall.EPERM,
		},
		{
			name:       "eperm_probe_visible_rekill_eperm_then_esrch",
			pgid:       testPGID,
			results:    []error{syscall.EPERM, nil, syscall.EPERM, syscall.ESRCH},
			wantCalls:  append(slices.Clone(rekill), killCall{pid: -testPGID, signal: 0}),
			wantPauses: 1,
			wantErr:    syscall.ESRCH,
			forbidErr:  syscall.EPERM,
		},
		{
			name:       "eperm_probe_visible_rekill_eio",
			pgid:       testPGID,
			results:    []error{syscall.EPERM, nil, syscall.EIO},
			wantCalls:  rekill,
			wantErr:    syscall.EIO,
			forbidErr:  syscall.EPERM,
			wantSubstr: "4242",
		},
		{
			name:    "non_positive_pgid_rejected",
			pgid:    0,
			wantErr: syscall.EINVAL,
		},
	}
}
