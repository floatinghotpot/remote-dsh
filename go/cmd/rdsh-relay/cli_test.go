package main

import (
	"reflect"
	"testing"
)

func TestReorderArgs(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{
			name: "位置参数在前 → 挪到末尾",
			in:   []string{"https://rdsh.cn", "--token", "t", "--advertise-url", "u", "--name", "n"},
			want: []string{"--token", "t", "--advertise-url", "u", "--name", "n", "https://rdsh.cn"},
		},
		{
			name: "flag 在前（已符合 Go flag）→ 不变",
			in:   []string{"--token", "t", "--advertise-url", "u", "https://rdsh.cn"},
			want: []string{"--token", "t", "--advertise-url", "u", "https://rdsh.cn"},
		},
		{
			name: "空参数 → 不变",
			in:   []string{},
			want: []string{},
		},
		{
			name: "只有位置参数 → 不变",
			in:   []string{"https://rdsh.cn"},
			want: []string{"https://rdsh.cn"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := reorderArgs(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("reorderArgs(%v) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
