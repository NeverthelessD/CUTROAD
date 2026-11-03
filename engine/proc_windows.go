//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	createNoWindow        = 0x08000000
	createNewProcessGroup = 0x00000200
	detachedProcess       = 0x00000008
)

var (
	shell32           = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteW = shell32.NewProc("ShellExecuteW")
	user32            = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW   = user32.NewProc("MessageBoxW")
)

// hideWindow keeps console tools from flashing a black window.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcess | createNewProcessGroup}
}

func detachSelf() {}

func shellExecute(target string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	t, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(t)), 0, 0, 1)
	if r <= 32 {
		return fmt.Errorf("ShellExecute failed (%d)", r)
	}
	return nil
}

// openPaths opens files/folders with their default app.
func openPaths(paths []string) {
	for _, p := range paths {
		shellExecute(p)
	}
}

// revealPaths opens Explorer with the (first) file selected.
func revealPaths(paths []string) {
	if len(paths) == 0 {
		return
	}
	explorer := filepath.Join(os.Getenv("WINDIR"), "explorer.exe")
	cmd := exec.Command(explorer)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + paths[0] + `"`}
	cmd.Start()
}

func messageBox(title, msg string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(msg)
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x30|0x10000) // MB_ICONWARNING | MB_SETFOREGROUND
}
