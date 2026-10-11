// Package tunnel implements the rdsh-tunnel wire protocol (PROTOCOL.md,
// FROZEN v1) in Go — the frame codec shared by the relay node and the future
// hub. It mirrors packages/tunnel/src/frame.ts field-for-field.
package tunnel

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// Protocol constants (PROTOCOL.md §帧格式).
var Magic = []byte{0x52, 0x44, 0x53, 0x48} // "RDSH"

const (
	ProtocolVersion   = 1
	FrameHeaderLength = 15
	MaxPayloadLength  = 16 * 1024 * 1024 // 16 MiB
)

// Frame types (PROTOCOL.md §帧类型 + A2 REDIRECT 预留).
const (
	TypeOpen     = 0x01
	TypeData     = 0x02
	TypeClose    = 0x03
	TypePing     = 0x04
	TypePong     = 0x05
	TypeError    = 0x06
	TypeRedirect = 0x80 // extension frame (A2, reserved for P1.5)
)

// CoreTypeMax is the frame-domain boundary (A1): type < 0x80 = core,
// type ≥ 0x80 = extension.
const CoreTypeMax = 0x7f

// FlagE2E marks an E2EE frame (flags bit0); unknown flag bits are preserved.
const FlagE2E = 0x01

// Frame is a decoded tunnel frame.
type Frame struct {
	Version  byte
	Flags    byte
	Type     byte
	StreamID uint32
	Payload  []byte
}

// ProtocolError is a protocol-level error (bad magic / version / oversize).
type ProtocolError struct{ msg string }

func (e *ProtocolError) Error() string { return e.msg }

func protoErrf(format string, args ...any) error {
	return &ProtocolError{msg: fmt.Sprintf(format, args...)}
}

// EncodeFrame encodes one frame (payload ≤ MaxPayloadLength).
func EncodeFrame(typ byte, streamID uint32, payload []byte, flags byte) ([]byte, error) {
	if len(payload) > MaxPayloadLength {
		return nil, protoErrf("payload too large: %d > %d", len(payload), MaxPayloadLength)
	}
	buf := make([]byte, FrameHeaderLength+len(payload))
	copy(buf[0:4], Magic)
	buf[4] = ProtocolVersion
	buf[5] = flags
	buf[6] = typ
	binary.BigEndian.PutUint32(buf[7:11], streamID)
	binary.BigEndian.PutUint32(buf[11:15], uint32(len(payload)))
	copy(buf[FrameHeaderLength:], payload)
	return buf, nil
}

// IsCoreType reports whether typ is a core frame (type < 0x80).
func IsCoreType(typ byte) bool { return typ < 0x80 }

// IsExtensionType reports whether typ is an extension frame (type ≥ 0x80).
func IsExtensionType(typ byte) bool { return typ >= 0x80 }

// IsUnknownCoreType reports whether typ is a core frame that is NOT a known
// OPEN..ERROR type (unknown core = protocol error per A1).
func IsUnknownCoreType(typ byte) bool {
	if !IsCoreType(typ) {
		return false
	}
	switch typ {
	case TypeOpen, TypeData, TypeClose, TypePing, TypePong, TypeError:
		return false
	default:
		return true
	}
}

// Parser is a streaming frame parser handling sticky packets and half-frames.
type Parser struct {
	buf []byte
}

// Push feeds a chunk and returns any complete frames decoded from it (0..n).
// A non-nil error is a ProtocolError; the parser must not be reused after it.
func (p *Parser) Push(chunk []byte) ([]Frame, error) {
	if len(chunk) > 0 {
		p.buf = append(p.buf, chunk...)
	}
	var frames []Frame
	for {
		if len(p.buf) < FrameHeaderLength {
			break
		}
		hdr := p.buf[:FrameHeaderLength]
		if !bytes.Equal(hdr[0:4], Magic) {
			return nil, protoErrf("invalid magic: not an rdsh-tunnel frame")
		}
		if hdr[4] != ProtocolVersion {
			return nil, protoErrf("unsupported protocol version: %d", hdr[4])
		}
		length := binary.BigEndian.Uint32(hdr[11:15])
		if length > MaxPayloadLength {
			return nil, protoErrf("frame payload too large: %d > %d", length, MaxPayloadLength)
		}
		total := FrameHeaderLength + int(length)
		if len(p.buf) < total {
			break // half frame — wait for more
		}
		// Copy payload: the returned frame must stay valid across later Push calls.
		payload := append([]byte(nil), p.buf[FrameHeaderLength:total]...)
		frames = append(frames, Frame{
			Version:  hdr[4],
			Flags:    hdr[5],
			Type:     hdr[6],
			StreamID: binary.BigEndian.Uint32(hdr[7:11]),
			Payload:  payload,
		})
		p.buf = p.buf[total:]
	}
	return frames, nil
}
