package tunnel

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestFrameHeaderFieldByField(t *testing.T) {
	frame, err := EncodeFrame(TypeData, 7, []byte("hello"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(frame) != FrameHeaderLength+5 {
		t.Fatalf("len = %d, want %d", len(frame), FrameHeaderLength+5)
	}
	if !bytes.Equal(frame[0:4], Magic) {
		t.Fatal("magic mismatch")
	}
	if frame[4] != ProtocolVersion {
		t.Fatalf("version = %d", frame[4])
	}
	if frame[5] != 0 {
		t.Fatalf("flags = %d", frame[5])
	}
	if frame[6] != TypeData {
		t.Fatalf("type = %d", frame[6])
	}
	if binary.BigEndian.Uint32(frame[7:11]) != 7 {
		t.Fatal("streamId mismatch")
	}
	if binary.BigEndian.Uint32(frame[11:15]) != 5 {
		t.Fatal("length mismatch")
	}
	if string(frame[FrameHeaderLength:]) != "hello" {
		t.Fatal("payload mismatch")
	}
}

func TestParserStickyPacket(t *testing.T) {
	f1, _ := EncodeFrame(TypeData, 1, []byte("a"), 0)
	f2, _ := EncodeFrame(TypeData, 2, []byte("bb"), 0)
	f3, _ := EncodeFrame(TypeClose, 2, []byte(`{"code":0}`), 0)
	var p Parser
	frames, err := p.Push(bytes.Join([][]byte{f1, f2, f3}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 3 {
		t.Fatalf("got %d frames, want 3", len(frames))
	}
}

func TestParserHalfFrame(t *testing.T) {
	frame, _ := EncodeFrame(TypeData, 42, []byte("hello world"), 0)
	var p Parser
	var total int
	for _, b := range frame {
		frames, err := p.Push([]byte{b})
		if err != nil {
			t.Fatal(err)
		}
		total += len(frames)
	}
	if total != 1 {
		t.Fatalf("decoded %d frames, want 1", total)
	}
}

func TestParserPayloadStableAcrossPush(t *testing.T) {
	a, _ := EncodeFrame(TypeData, 1, []byte("first"), 0)
	b, _ := EncodeFrame(TypeData, 2, []byte("second"), 0)
	var p Parser
	frames, err := p.Push(bytes.Join([][]byte{a, b}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if string(frames[0].Payload) != "first" || string(frames[1].Payload) != "second" {
		t.Fatal("payload aliasing broke frame contents")
	}
}

func TestOversizePayload(t *testing.T) {
	_, err := EncodeFrame(TypeData, 1, make([]byte, MaxPayloadLength+1), 0)
	if err == nil {
		t.Fatal("expected ProtocolError for oversize payload")
	}
}

func TestBadMagic(t *testing.T) {
	var p Parser
	bad := make([]byte, FrameHeaderLength)
	if _, err := p.Push(bad); err == nil {
		t.Fatal("expected ProtocolError for bad magic")
	}
}

func TestVersionMismatch(t *testing.T) {
	hdr := make([]byte, FrameHeaderLength)
	copy(hdr[0:4], Magic)
	hdr[4] = 99
	hdr[6] = TypePing
	var p Parser
	if _, err := p.Push(hdr); err == nil {
		t.Fatal("expected ProtocolError for version mismatch")
	}
}

func TestFrameDomainBoundary(t *testing.T) {
	if CoreTypeMax != 0x7f {
		t.Fatal("CoreTypeMax must be 0x7f")
	}
	if !IsCoreType(0x06) || !IsCoreType(0x7f) || IsCoreType(0x80) {
		t.Fatal("core/ext boundary wrong")
	}
	if !IsExtensionType(0x80) || !IsExtensionType(0xff) || IsExtensionType(0x06) {
		t.Fatal("extension boundary wrong")
	}
	for _, typ := range []byte{TypeOpen, TypeData, TypeClose, TypePing, TypePong, TypeError} {
		if IsUnknownCoreType(typ) {
			t.Fatalf("known core type 0x%02x flagged unknown", typ)
		}
	}
	if !IsUnknownCoreType(0x07) || !IsUnknownCoreType(0x00) {
		t.Fatal("unknown core type not flagged")
	}
	if IsUnknownCoreType(0x80) {
		t.Fatal("REDIRECT extension must not be unknown-core")
	}
}

func TestRedirectReserved(t *testing.T) {
	if TypeRedirect != 0x80 {
		t.Fatalf("REDIRECT = 0x%02x, want 0x80", TypeRedirect)
	}
	if !IsExtensionType(TypeRedirect) {
		t.Fatal("REDIRECT must be an extension frame")
	}
}
