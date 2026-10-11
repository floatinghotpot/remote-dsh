// Command rdsh-relay is the standalone relay node (feature 30-relay-node).
//
// It terminates the layer-2 rdsh-tunnel from host gateways and forwards client
// HTTP/SSE/WebSocket/E2EE traffic to them — the data plane extracted from the
// hub monolith. The account service (Node) stays as the authoritative directory
// and assigns hosts to nodes at connect time.
package main

import (
	"fmt"
	"os"
)

func main() {
	if err := dispatch(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "rdsh-relay:", err)
		os.Exit(1)
	}
}
