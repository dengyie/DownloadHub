package main

import "errors"

var (
	ErrGrantLimit = errors.New("待处理兑换凭证过多，请使用已有凭证或稍后重试")
	ErrInvalid    = errors.New("请求参数无效")
	ErrDenied     = errors.New("卡密无效或无权访问")
	ErrExpired    = errors.New("凭证或授权已过期")
	ErrBusy       = errors.New("授权正在处理中，请稍后用同一凭证重试")
	ErrQuota      = errors.New("授权次数已用完")
	ErrBackend    = errors.New("文件服务暂时不可用，请重试")
)
