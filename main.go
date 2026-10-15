package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "dev"

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		return
	}
	if args[0] == "backup" {
		flags := flag.NewFlagSet("backup", flag.ExitOnError)
		src := flags.String("db", "", "source database")
		out := flags.String("out", "", "new backup path")
		flags.Parse(args[1:])
		if *src == "" || *out == "" || flags.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "backup requires --db and --out")
			os.Exit(1)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := backupDatabase(ctx, *src, *out); err != nil {
			slog.Error("backup failed", "error_type", fmt.Sprintf("%T", err))
			os.Exit(1)
		}
		fmt.Println("backup verified")
		return
	}
	if args[0] == "version" {
		fmt.Println(version)
		return
	}
	if args[0] != "serve" {
		RunGen(args, "")
		return
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	path := fs.String("config", "config.yaml", "配置路径")
	fs.Parse(args[1:])
	cfg, err := loadConfig(*path)
	if err != nil {
		slog.Error("configuration invalid", "error", err)
		os.Exit(1)
	}
	if err = runServer(cfg); err != nil {
		slog.Error("server stopped", "error_type", fmt.Sprintf("%T", err))
		os.Exit(1)
	}
}
func printUsage() {
	fmt.Fprintln(os.Stderr, "opencardgate serve --config config.yaml | version | gencard | listcards | revokecard")
}
func runServer(cfg Config) error {
	db, err := openDB(cfg.DBPath)
	if err != nil {
		return err
	}
	defer db.Close()
	h := newHandler(db, NewOLClient(cfg.OpenListURL, cfg.OLAdminUser, cfg.OLAdminPass), cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				maint, cancel := context.WithTimeout(ctx, 3*time.Second)
				started := time.Now()
				err := h.service.store.cleanup(maint, time.Now(), time.Duration(cfg.AuditRetentionDays)*24*time.Hour)
				// Capture the operation context before cancel marks a successful budget canceled.
				logMaintenanceFailure(maint, slog.Default(), err, time.Since(started))
				cancel()
			}
		}
	}()
	server := &http.Server{Addr: cfg.Listen, Handler: h.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	result := make(chan error, 1)
	go func() { result <- server.ListenAndServe() }()
	slog.Info("opencardgate started", "version", version, "schema", schemaVersion, "listen", cfg.Listen)
	select {
	case err = <-result:
		stop()
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		err = server.Shutdown(shutdown)
		cancel()
		if err != nil {
			server.Close()
		}
	}
	stop()
	<-workerDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
