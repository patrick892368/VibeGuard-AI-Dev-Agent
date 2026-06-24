package com.example;

public class UserService {
    public String displayName(String rawName) {
        return rawName == null ? "unknown" : rawName.trim();
    }
}
