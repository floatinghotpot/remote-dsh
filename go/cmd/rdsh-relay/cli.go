package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func printUsage() {
	fmt.Fprint(os.Stderr, `Usage: rdsh-relay <subcommand>

  join <account-url> --token <t> --advertise-url <url> [--name <n>] [--data-dir <d>]
      Register this node with the account service and write relay.json.
  serve [--data-dir <d>]
      Run the relay node in the foreground.
  service install|status|start|stop|restart|uninstall
      Run as a systemd service.
  leave [--data-dir <d>]
      Unregister this node from the account service.
  status [--data-dir <d>]
      Show this node's configuration and state.
`)
}

// dispatch routes argv to a subcommand.
func dispatch(args []string) error {
	if len(args) == 0 {
		printUsage()
		return nil
	}
	switch args[0] {
	case "join":
		return cmdJoin(args[1:])
	case "serve":
		return cmdServe(args[1:])
	case "leave":
		return cmdLeave(args[1:])
	case "status":
		return cmdStatus(args[1:])
	case "service":
		return cmdService(args[1:])
	default:
		printUsage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func flagDataDir(fs *flag.FlagSet, dataDir *string) {
	fs.StringVar(dataDir, "data-dir", defaultDataDir(), "state directory (default ~/.rdsh/relay)")
}

func cmdJoin(args []string) error {
	fs := flag.NewFlagSet("join", flag.ExitOnError)
	var token, advertiseURL, name, dataDir string
	fs.StringVar(&token, "token", "", "node token from the account service admin UI")
	fs.StringVar(&advertiseURL, "advertise-url", "", "public node URL (https://sg01.tunnel.rdsh.cn)")
	fs.StringVar(&name, "name", "", "display name")
	flagDataDir(fs, &dataDir)
	_ = fs.Parse(args)

	accountURL := fs.Arg(0)
	if accountURL == "" || token == "" || advertiseURL == "" {
		return fmt.Errorf("usage: rdsh-relay join <account-url> --token <t> --advertise-url <url> [--name <n>]")
	}

	acc := newAccount(accountURL, token)
	info, err := acc.Register(name, advertiseURL, []string{"relay-v1"})
	if err != nil {
		return fmt.Errorf("register failed: %w", err)
	}

	cfg := &Config{
		AccountURL:   accountURL,
		AdvertiseURL: advertiseURL,
		Name:         name,
		NodeID:       info.NodeID,
		NodeToken:    token,
	}
	if err := saveConfig(dataDir, cfg); err != nil {
		return err
	}
	fmt.Printf("rdsh-relay: joined as node %s → %s\n", info.NodeID, accountURL)
	fmt.Println("rdsh-relay: next run `rdsh-relay serve` (or `rdsh-relay service install`).")
	return nil
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var dataDir string
	flagDataDir(fs, &dataDir)
	_ = fs.Parse(args)
	return serve(dataDir)
}

func cmdLeave(args []string) error {
	fs := flag.NewFlagSet("leave", flag.ExitOnError)
	var dataDir string
	flagDataDir(fs, &dataDir)
	_ = fs.Parse(args)

	cfg, err := loadConfig(dataDir)
	if err != nil {
		return err
	}
	acc := newAccount(cfg.AccountURL, cfg.NodeToken)
	if err := acc.post("/api/nodes/leave", map[string]any{"nodeId": cfg.NodeID}, nil); err != nil {
		return fmt.Errorf("leave failed: %w", err)
	}
	if err := os.Remove(filepath.Join(dataDir, "relay.json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Printf("rdsh-relay: node %s left the account service\n", cfg.NodeID)
	return nil
}

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	var dataDir string
	flagDataDir(fs, &dataDir)
	_ = fs.Parse(args)

	cfg, err := loadConfig(dataDir)
	if err != nil {
		return err
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	fmt.Println(string(b))
	return nil
}

func cmdService(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: rdsh-relay service install|status|start|stop|restart|uninstall")
	}
	action := args[0]
	dataDir := defaultDataDir()
	for i := 1; i < len(args)-1; i++ {
		if args[i] == "--data-dir" {
			dataDir = args[i+1]
		}
	}
	switch action {
	case "install":
		if err := serviceInstall(dataDir); err != nil {
			return err
		}
		fmt.Printf("rdsh-relay: service installed (%s)\n", serviceName)
		return nil
	case "status":
		return serviceStatus()
	case "start":
		return serviceStart()
	case "stop":
		return serviceStop()
	case "restart":
		return serviceRestart()
	case "uninstall":
		return serviceUninstall()
	default:
		return fmt.Errorf("usage: rdsh-relay service install|status|start|stop|restart|uninstall")
	}
}

func saveConfig(dir string, cfg *Config) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	cfg.DataDir = dir
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "relay.json")
	return os.WriteFile(path, b, 0o600)
}
