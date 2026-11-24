//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package boundedexec

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const (
	settleDeadline = 2 * time.Second
	pollInterval   = 10 * time.Millisecond
	maxProbes      = 200
)

type processGroupKiller struct {
	kill  func(int, syscall.Signal) error
	pause func(time.Duration)
	now   func() time.Time
}

// KillProcessGroup sends SIGKILL to process group pgid. It returns nil when the
// signal was delivered and an error matching syscall.ESRCH when the group is
// gone. Darwin can answer EPERM for a group whose leader was just reaped
// before it answers ESRCH, so an EPERM starts a bounded probe that waits for
// ESRCH; an EPERM that outlasts the bound is a real permission refusal and is
// returned as an error matching syscall.EPERM.
func KillProcessGroup(pgid int) error {
	killer := processGroupKiller{
		kill:  syscall.Kill,
		pause: time.Sleep,
		now:   time.Now,
	}
	return killer.killProcessGroup(pgid)
}

func (killer processGroupKiller) killProcessGroup(pgid int) error {
	if pgid <= 0 {
		return fmt.Errorf("invalid process group %d: %w", pgid, syscall.EINVAL)
	}
	err := killer.kill(-pgid, syscall.SIGKILL)
	if err == nil {
		return nil
	}
	if !errors.Is(err, syscall.EPERM) {
		return fmt.Errorf("kill process group %d: %w", pgid, err)
	}
	return killer.settleAfterEPERM(pgid)
}

func (killer processGroupKiller) settleAfterEPERM(pgid int) error {
	started := killer.now()
	deadline := started.Add(settleDeadline)
	for probe := 0; probe < maxProbes; probe++ {
		done, err := killer.probeGroup(pgid)
		if done {
			return err
		}
		if probe+1 == maxProbes || !killer.now().Before(deadline) {
			break
		}
		killer.pause(pollInterval)
	}
	return fmt.Errorf(
		"process group %d still refuses SIGKILL after %s: %w",
		pgid,
		killer.now().Sub(started),
		syscall.EPERM,
	)
}

func (killer processGroupKiller) probeGroup(pgid int) (bool, error) {
	probeErr := killer.kill(-pgid, 0)
	if errors.Is(probeErr, syscall.EPERM) {
		return false, nil
	}
	if probeErr != nil {
		return true, fmt.Errorf("probe process group %d: %w", pgid, probeErr)
	}
	killErr := killer.kill(-pgid, syscall.SIGKILL)
	if killErr == nil {
		return true, nil
	}
	if errors.Is(killErr, syscall.EPERM) {
		return false, nil
	}
	return true, fmt.Errorf("kill process group %d: %w", pgid, killErr)
}

// KillProcessGroupOnCancel starts command in its own process group and makes
// context cancellation kill the whole group, so descendants cannot outlive
// it. The returned cleanup kills the group once more after Wait; a group that
// is already gone counts as cleaned up.
func KillProcessGroupOnCancel(command *exec.Cmd) func() error {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cleanup := func() error {
		if command.Process == nil {
			return nil
		}
		err := KillProcessGroup(command.Process.Pid)
		if errors.Is(err, syscall.ESRCH) || errors.Is(err, os.ErrProcessDone) {
			return nil
		}
		return err
	}
	command.Cancel = cleanup
	return cleanup
}
