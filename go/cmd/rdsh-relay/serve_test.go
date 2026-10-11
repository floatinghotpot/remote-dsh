package main

import "testing"

// F5：nodeMeter 回归测试（F1 修复配套）。锁住「累计不清空 / 跨日重置 / 每进程独立 instanceID」。

func TestNodeMeterCumulative(t *testing.T) {
	m := newNodeMeter()
	date := m.day
	// 第一个窗口
	m.add("host-1", 42, 1000, 2000)
	rows := m.report(date)
	if len(rows) != 1 || rows[0].RelayBytesUp != 1000 || rows[0].RelayBytesDown != 2000 {
		t.Fatalf("first report = %+v", rows)
	}
	if rows[0].RelaySeconds != 0 || rows[0].Sessions != 1 {
		t.Fatalf("relaySeconds/sessions should be 0/1, got %+v", rows[0])
	}
	// 第二个窗口：应为当日累计，而非窗口增量
	m.add("host-1", 42, 500, 700)
	rows = m.report(date)
	if len(rows) != 1 || rows[0].RelayBytesUp != 1500 || rows[0].RelayBytesDown != 2700 {
		t.Fatalf("second report should be cumulative (1500/2700), got %+v", rows)
	}
	// 无变化 → 空（dirty 语义）
	rows = m.report(date)
	if len(rows) != 0 {
		t.Fatalf("no-change report should be empty, got %+v", rows)
	}
}

func TestNodeMeterDayRollover(t *testing.T) {
	m := newNodeMeter()
	day1 := m.day
	m.add("host-1", 42, 1000, 2000)
	_ = m.report(day1) // 同日 dirty 上报（不清 usage）
	// 跨日：返回旧日全量并重置
	day2 := "2099-01-02"
	rows := m.report(day2)
	if len(rows) != 1 || rows[0].Date != day1 || rows[0].RelayBytesUp != 1000 || rows[0].RelayBytesDown != 2000 {
		t.Fatalf("rollover should return day1 full (1000/2000), got %+v", rows)
	}
	// 跨日后无流量 → 空
	rows = m.report(day2)
	if len(rows) != 0 {
		t.Fatalf("post-rollover no-change should be empty, got %+v", rows)
	}
	// 跨日后新流量 → 新日累计
	m.add("host-1", 42, 300, 400)
	rows = m.report(day2)
	if len(rows) != 1 || rows[0].Date != day2 || rows[0].RelayBytesUp != 300 || rows[0].RelayBytesDown != 400 {
		t.Fatalf("day2 cumulative (300/400), got %+v", rows)
	}
}

func TestNodeMeterInstanceID(t *testing.T) {
	a := newNodeMeter()
	b := newNodeMeter()
	if a.instanceID == "" || b.instanceID == "" || a.instanceID == b.instanceID {
		t.Fatalf("instanceID should be non-empty and distinct: %q vs %q", a.instanceID, b.instanceID)
	}
}
