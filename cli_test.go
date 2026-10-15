package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCLIHelper(t *testing.T) {
	if os.Getenv("DOWNLOADHUB_CLI_TEST") != "1" && os.Getenv("OPENCARDGATE_CLI_TEST") != "1" && os.Getenv("CARDGW_CLI_TEST") != "1" {
		return
	}
	db := os.Getenv("DOWNLOADHUB_CLI_DB")
	if db == "" {
		db = os.Getenv("OPENCARDGATE_CLI_DB")
	}
	if db == "" {
		db = os.Getenv("CARDGW_CLI_DB")
	}
	for i, arg := range os.Args {
		if arg == "--" {
			RunGen(os.Args[i+1:], db)
			os.Exit(0)
		}
	}
	os.Exit(2)
}

func TestCLIInvalidInputDoesNotTouchDatabase(t *testing.T) {
	cases := [][]string{
		{"gencard"}, {"gencard", "--group", "guest"},
		{"gencard", "--days", "invalid"}, {"gencard", "--days", "-1"},
		{"gencard", "--days", "9999999999999999999999999"}, {"gencard", "--days", "106752"},
		{"gencard", "--quota", "oops"}, {"gencard", "--quota", "0"},
		{"gencard", "--group", "vpi"}, {"gencard", "--resource", "pub/../secret"},
		{"gencard", "--resource", "pub/a,,pub/b"}, {"gencard", "--resource", "pub/a", "--prefix", "/pub/"},
		{"gencard", "unexpected"}, {"gencard", "--resource", ""}, {}, {"revokecard"},
	}
	for _, args := range cases {
		t.Run("args="+joinArgs(args), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "cards.db")
			cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestCLIHelper$", "--"}, args...)...)
			cmd.Env = append(os.Environ(), "DOWNLOADHUB_CLI_TEST=1", "DOWNLOADHUB_CLI_DB="+path)
			out, err := cmd.CombinedOutput()
			if err == nil {
				t.Errorf("invalid input succeeded: %s", out)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Error("invalid input touched database")
			}
		})
	}
}
func joinArgs(args []string) string {
	var s string
	for _, a := range args {
		s += a + " "
	}
	return s
}

func TestCLIValidPermanentCardPreservesLiteralFilename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cards.db")
	cmd := exec.Command(os.Args[0], "-test.run=^TestCLIHelper$", "--", "gencard", "--quota", "2", "--days", "0", "--resource", "pub/a%20b.zip")
	cmd.Env = append(os.Environ(), "DOWNLOADHUB_CLI_TEST=1", "DOWNLOADHUB_CLI_DB="+path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cards, err := ListCards(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0].Quota != 2 || cards[0].ExpiresAt != nil || len(cards[0].Resources) != 1 || cards[0].Resources[0] != "pub/a%20b.zip" {
		t.Fatalf("unexpected cards: %+v", cards)
	}
}
