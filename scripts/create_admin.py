#!/usr/bin/env python3
"""
scripts/create_admin.py

Usage:
  python scripts/create_admin.py <username> <password>

Creates (or updates) an "users" table in data.db and inserts the provided user with a hashed password.
Prefers werkzeug.generate_password_hash if available, otherwise falls back to salted SHA-256.
"""
import sys
import sqlite3
from datetime import datetime

DB_PATH = "data.db"

def hash_password(password):
    # Try werkzeug first (Flask installs werkzeug)
    try:
        from werkzeug.security import generate_password_hash
        return generate_password_hash(password)
    except Exception:
        import hashlib, uuid
        salt = uuid.uuid4().hex
        digest = hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
        # store salt + digest so we can verify later if needed
        return f"sha256${salt}${digest}"

def main():
    if len(sys.argv) < 3:
        print("Usage: python scripts/create_admin.py <username> <password>")
        sys.exit(1)
    username = sys.argv[1].strip()
    password = sys.argv[2]

    pw_hash = hash_password(password)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        created_at TEXT
      )
    ''')
    # upsert: replace on conflict by username
    cur.execute('''
      INSERT INTO users (username, password, role, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET password=excluded.password, role=excluded.role, created_at=excluded.created_at
    ''', (username, pw_hash, "admin", datetime.utcnow().isoformat() + "Z"))
    conn.commit()
    conn.close()
    print(f"User '{username}' created/updated in {DB_PATH}.")
    print("Note: store the password safely and rotate tokens if needed.")

if __name__ == "__main__":
    main()
