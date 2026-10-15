package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"strconv"
)

// RunGen 处理 admin CLI 命令: gencard / listcards / revokecard
// 用法:
//
//	# 新模式: 卡绑定具体资源路径列表
//	cardgw gencard --quota N --resource private/文件A.zip,private/说明.txt [--days D]
//	# 旧模式: 卡绑定前缀权限组
//	cardgw gencard --quota 10 --group vip --prefix /exclusive/ [--days 30]
//	cardgw listcards
//	cardgw revokecard --card <id>
func RunGen(args []string, dbPath string) {
	if dbPath == "" {
		dbPath = "./cards.db"
	}
	// 子命令名在 args[0](如 "gencard"),后面才是 flag 参数。
	// 需先剥离子命令名再解析 flag,否则 fs.Parse 遇第一个位置参数(gencard)会停止解析后续 flag。
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	var flagArgs []string
	if len(args) > 0 {
		flagArgs = args[1:]
	}

	fs := flag.NewFlagSet("downloadhub", flag.ExitOnError)
	var quota, group, prefix, resource, days, card, db string
	fs.StringVar(&db, "db", "", "SQLite 数据库路径(默认 ./cards.db)")
	fs.StringVar(&quota, "quota", "10", "剩余下载次数")
	fs.StringVar(&group, "group", "member", "guest|member|vip (旧前缀模式用)")
	fs.StringVar(&prefix, "prefix", "", "允许路径前缀,逗号分隔(旧模式)")
	fs.StringVar(&resource, "resource", "", "绑定具体资源路径,逗号分隔(新模式,推荐)")
	fs.StringVar(&days, "days", "30", "有效期天数,0=永久")
	fs.StringVar(&card, "card", "", "卡号(revokecard 用)")
	_ = fs.Parse(flagArgs)
	if db != "" {
		dbPath = db
	}

	// Validate the complete command before opening (and potentially migrating) a database.
	fail := func(err error) { fmt.Fprintln(os.Stderr, "downloadhub:", err); os.Exit(1) }
	if fs.NArg() != 0 {
		fail(fmt.Errorf("不接受位置参数: %v", fs.Args()))
	}
	var q, d int
	var ttl *int
	var resources, prefixes []string
	switch cmd {
	case "gencard":
		fs.Visit(func(f *flag.Flag) {
			if (f.Name == "resource" || f.Name == "prefix") && f.Value.String() == "" {
				fail(fmt.Errorf("%s 不能为空", f.Name))
			}
		})
		var err error
		q, err = strconv.Atoi(quota)
		if err != nil {
			fail(fmt.Errorf("quota 必须为整数"))
		}
		d, err = strconv.Atoi(days)
		if err != nil {
			fail(fmt.Errorf("days 必须为整数"))
		}
		ttl = &d
		resources, prefixes = parseCardList(resource), parseCardList(prefix)
		if err := validateCardInput(q, group, prefixes, resources, ttl); err != nil {
			fail(err)
		}
		if d == 0 {
			ttl = nil
		}
	case "revokecard":
		if card == "" {
			fail(fmt.Errorf("revokecard 需要 --card"))
		}
	case "listcards":
		default:
			fail(fmt.Errorf("用法: downloadhub gencard|listcards|revokecard [参数]"))
	}
	dbConn, err := openDB(dbPath)
	if err != nil {
		fail(fmt.Errorf("open db: %w", err))
	}
	defer dbConn.Close()
	switch cmd {
	case "gencard":
		card, err := CreateCard(dbConn, q, group, prefixes, resources, ttl)
		if err != nil {
			fmt.Fprintln(os.Stderr, "gencard:", err)
			os.Exit(1)
		}
		fmt.Printf("卡已生成: 卡号=%s 密钥=%s\n", card.CardID, card.Secret)
		fmt.Printf("  次数=%d 权限组=%s", card.Quota, card.PermGroup)
		if len(card.Resources) > 0 {
			fmt.Printf(" 资源=%v", card.Resources)
		} else {
			fmt.Printf(" 前缀=%v", card.Prefixes)
		}
		if card.ExpiresAt != nil {
			fmt.Printf(" 到期=%s", card.ExpiresAt.Format("2006-01-02"))
		} else {
			fmt.Print(" 永久")
		}
		fmt.Println()
		if len(card.Resources) > 0 {
			fmt.Printf("兑换页: /redeem (或站点域名/redeem)\n")
		} else {
			fmt.Printf("下载确认页: /dl%s?card=%s&key=%s\n",
				card.Prefixes[0], card.CardID, card.Secret)
			fmt.Printf("(将前缀替换为完整资源路径；打开页面不扣次，需点击签发按钮以 POST 确认下载授权)\n")
		}

	case "listcards":
		listCardsOut(dbConn)

	case "revokecard":
		if err := RevokeCard(dbConn, card); err != nil {
			fmt.Fprintln(os.Stderr, "revoke:", err)
			os.Exit(1)
		}
		fmt.Printf("卡 %s 已吊销\n", card)

	}
}

func listCardsOut(db *sql.DB) {
	cards, err := ListCards(db)
	if err != nil {
		fmt.Fprintln(os.Stderr, "list:", err)
		os.Exit(1)
	}
	if len(cards) == 0 {
		fmt.Println("(无卡)")
		return
	}
	for _, c := range cards {
		exp := "永久"
		if c.ExpiresAt != nil {
			exp = c.ExpiresAt.Format("2006-01-02")
		}
		rev := ""
		if c.Revoked {
			rev = " [吊销]"
		}
		auth := fmt.Sprintf("%v", c.Prefixes)
		if len(c.Resources) > 0 {
			auth = fmt.Sprintf("资源=%v", c.Resources)
		}
		fmt.Printf("%s | 次数=%d | %s | %s | 到期=%s%s\n",
			c.CardID, c.Quota,
			c.PermGroup, auth, exp, rev)
	}
}
