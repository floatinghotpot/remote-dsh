package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const serviceName = "rdsh-relay"

// serviceInstall installs + enables the node as a user service (systemd on
// Linux, launchd on macOS). Mirrors `rdsh host service install`.
func serviceInstall(dataDir string) error {
	bin, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot determine binary path: %w", err)
	}
	if runtime.GOOS == "linux" {
		unit := fmt.Sprintf(`[Unit]
Description=rdsh relay node
After=network-online.target

[Service]
ExecStart=%s serve --data-dir %s
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`, bin, dataDir)
		dir := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		path := filepath.Join(dir, serviceName+".service")
		if err := os.WriteFile(path, []byte(unit), 0o600); err != nil {
			return err
		}
		if err := run("systemctl", "--user", "daemon-reload"); err != nil {
			return err
		}
		if err := run("systemctl", "--user", "enable", "--now", serviceName); err != nil {
			return err
		}
		fmt.Printf("installed systemd user unit: %s\n", path)
		return nil
	}
	// macOS launchd
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.%s</string>
  <key>ProgramArguments</key><array><string>%s</string><string>serve</string><string>--data-dir</string><string>%s</string></array>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
`, serviceName, bin, dataDir)
	path := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", "com."+serviceName+".plist")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(plist), 0o600); err != nil {
		return err
	}
	_ = run("launchctl", "unload", path)
	if err := run("launchctl", "load", path); err != nil {
		return err
	}
	fmt.Printf("installed launchd plist: %s\n", path)
	return nil
}

func serviceStatus() error {
	if runtime.GOOS == "linux" {
		out, err := exec.Command("systemctl", "--user", "is-active", serviceName).Output()
		if err != nil {
			fmt.Println("inactive")
			return nil
		}
		fmt.Printf("active: %s", out)
		return nil
	}
	out, err := exec.Command("launchctl", "print", "com."+serviceName).Output()
	if err != nil {
		fmt.Println("unloaded")
		return nil
	}
	if strings.Contains(string(out), "state = running") {
		fmt.Println("active")
	} else {
		fmt.Println("loaded (not running)")
	}
	return nil
}

func serviceStart() error {
	if runtime.GOOS == "linux" {
		return run("systemctl", "--user", "start", serviceName)
	}
	return run("launchctl", "kickstart", "-k", "com."+serviceName)
}

func serviceStop() error {
	if runtime.GOOS == "linux" {
		return run("systemctl", "--user", "stop", serviceName)
	}
	return run("launchctl", "stop", "com."+serviceName)
}

func serviceRestart() error {
	if runtime.GOOS == "linux" {
		return run("systemctl", "--user", "restart", serviceName)
	}
	return run("launchctl", "kickstart", "-k", "com."+serviceName)
}

func serviceUninstall() error {
	if runtime.GOOS == "linux" {
		_ = run("systemctl", "--user", "disable", "--now", serviceName)
		path := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", serviceName+".service")
		_ = os.Remove(path)
		return run("systemctl", "--user", "daemon-reload")
	}
	path := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", "com."+serviceName+".plist")
	_ = run("launchctl", "unload", path)
	return os.Remove(path)
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
