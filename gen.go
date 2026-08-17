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
//	cardgw gencard --quota N --resource pub/文件A.zip,pub/说明.txt [--days D]
//	# 旧模式: 卡绑定前缀权限组
//	cardgw gencard --quota 10 --group vip --prefix /pub/,/exclusive/ [--days 30]
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
	flagArgs := args[1:]

	fs := flag.NewFlagSet("cardgw", flag.ExitOnError)
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

	dbConn, err := openDB(dbPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open db:", err)
		os.Exit(1)
	}
	defer dbConn.Close()

	switch cmd {
	case "gencard":
		q, _ := strconv.Atoi(quota)
		d, _ := strconv.Atoi(days)
		var ttl *int
		if d > 0 {
			ttl = &d
		}
		resources := splitNonEmpty(resource, ",")
		prefixes := splitNonEmpty(prefix, ",")
		if len(resources) == 0 && len(prefixes) == 0 {
			// 都没指定时: 默认按 group 走前缀模式(兼容旧行为)
			prefixes = defaultPrefixes(group)
		}
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
			fmt.Printf("兑换页: https://download.mangoqwq.com/redeem\n")
		} else {
			fmt.Printf("下载用法: /dl%s?card=%s&key=%s\n",
				card.Prefixes[0], card.CardID, card.Secret)
			fmt.Printf("(上述为示例;实际以文件完整路径拼接)\n")
		}

	case "listcards":
		listCardsOut(dbConn)

	case "revokecard":
		if card == "" {
			fmt.Fprintln(os.Stderr, "用法: cardgw revokecard --card <卡号> [--db <path>]")
			os.Exit(1)
		}
		if err := RevokeCard(dbConn, card); err != nil {
			fmt.Fprintln(os.Stderr, "revoke:", err)
			os.Exit(1)
		}
		fmt.Printf("卡 %s 已吊销\n", card)

	default:
		fmt.Fprintln(os.Stderr, "用法:")
		fmt.Fprintln(os.Stderr, "  # 绑资源(推荐): cardgw gencard --quota N --resource pub/a.zip,pub/b.txt [--days D] [--db PATH]")
		fmt.Fprintln(os.Stderr, "  # 绑前缀(兼容): cardgw gencard --quota N --group g --prefix /pub/,/share/ [--days D]")
		fmt.Fprintln(os.Stderr, "  cardgw listcards [--db PATH]")
		fmt.Fprintln(os.Stderr, "  cardgw revokecard --card <id> [--db PATH]")
		os.Exit(1)
	}
}

func defaultPrefixes(group string) []string {
	switch group {
	case "guest":
		return []string{"/pub/"}
	case "member":
		return []string{"/pub/", "/share/"}
	default: // vip
		return []string{"/pub/", "/share/", "/exclusive/"}
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
