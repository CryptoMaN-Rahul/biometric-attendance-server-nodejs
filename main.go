package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// PunchLog represents the structure of the data sent by the biometric device
type PunchLog struct {
	UserID string `json:"user_id"`
	IOTime string `json:"io_time"`
	IOMode int    `json:"io_mode"`
	FKName string `json:"fk_name,omitempty"`
}

// AttendanceStore defines the interface for data persistence (e.g., Firebase, SQL)
type AttendanceStore interface {
	SavePunch(log PunchLog, status string) error
}

// SimpleStore is a placeholder implementation of AttendanceStore
type SimpleStore struct{}

func (s *SimpleStore) SavePunch(p PunchLog, status string) error {
	log.Printf("[STORE] Saving: User %s | Time %s | Status %s", p.UserID, p.IOTime, status)
	return nil
}

// MapIOMode translates the raw bitmask integer to a human-readable status
func MapIOMode(mode int) string {
	switch mode {
	case 16777216:
		return "Check-In"
	case 33554432:
		return "Check-Out"
	case 50331648:
		return "Break-In"
	case 67108864:
		return "Break-Out"
	case 83886080:
		return "Overtime-In"
	case 100663296:
		return "Overtime-Out"
	default:
		return fmt.Sprintf("Unknown (%d)", mode)
	}
}

type AttendanceHandler struct {
	Store AttendanceStore
}

func (h *AttendanceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/hdata.aspx" {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[ERROR] Reading body: %v", err)
		http.Error(w, "Internal Error", http.StatusInternalServerError)
		return
	}

	rawString := string(body)
	start := strings.Index(rawString, "{")
	end := strings.LastIndex(rawString, "}")

	cmdID := r.Header.Get("cmd_id")
	responseText := "OK"

	if start != -1 && end != -1 && end > start {
		jsonPart := rawString[start : end+1]
		var punch PunchLog
		if err := json.Unmarshal([]byte(jsonPart), &punch); err != nil {
			log.Printf("[ERROR] Unmarshal JSON: %v", err)
		} else {
			if punch.UserID != "" && punch.IOTime != "" {
				status := MapIOMode(punch.IOMode)
				log.Printf("[PUNCH] User: %s | Time: %s | Status: %s", punch.UserID, punch.IOTime, status)
				h.Store.SavePunch(punch, status)
				responseText = "result=OK"
			} else if punch.FKName != "" {
				log.Printf("[INFO] Heartbeat from: %s", punch.FKName)
				responseText = "OK"
			}
		}
	}

	// For certain protocols, "result=OK" is required for data actions
	if cmdID == "RTLogSendAction" || cmdID == "RTEnrollDataAction" {
		responseText = "result=OK"
	}

	// Critical: Force connection close and minimal headers
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("Connection", "close")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, responseText)
}

func main() {
	handler := &AttendanceHandler{
		Store: &SimpleStore{},
	}

	port := ":3000"
	log.Printf("Go Attendance Server listening on %s", port)
	if err := http.ListenAndServe(port, handler); err != nil {
		log.Fatal(err)
	}
}
