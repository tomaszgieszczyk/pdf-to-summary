package main

import (
	"errors"
	"io"
	"os"
	"syscall"
)

// Check the free-space reserve throughout long uploads, including chunked requests.
func copyUpload(file *os.File, src io.Reader, root string, reserve uint64) (int64, error) {
	buf := make([]byte, 64<<10)
	var written, checkAt int64
	for {
		if written >= checkAt {
			available, err := availableBytes(root)
			if err != nil {
				return written, err
			}
			if available <= reserve {
				return written, problem{507, "Insufficient temporary storage."}
			}
			checkAt = written + int64(min(available-reserve, 8<<20))
		}
		limit := min(int64(len(buf)), checkAt-written)
		n, readErr := src.Read(buf[:limit])
		if n > 0 {
			count, err := file.Write(buf[:n])
			written += int64(count)
			if errors.Is(err, syscall.ENOSPC) {
				return written, problem{507, "Insufficient temporary storage."}
			}
			if err != nil {
				return written, err
			}
			if count != n {
				return written, io.ErrShortWrite
			}
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}
