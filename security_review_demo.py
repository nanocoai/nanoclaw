

import os
import sqlite3
import subprocess
from pathlib import Path


DB_PATH = "demo.db"

# Finding 1: hardcoded secret
ADMIN_TOKEN = "admin-token-123456"


def find_user_by_name(username: str):
    """
    Finding 2: SQL injection.
    User input is directly concatenated into SQL.
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    query = "SELECT id, username, role FROM users WHERE username = '" + username + "'"
    cursor.execute(query)

    return cursor.fetchall()


def export_file(filename: str) -> str:
    """
    Finding 3: path traversal.
    User-controlled filename is joined into a filesystem path without validation.
    """
    base_dir = Path("./exports")
    file_path = base_dir / filename

    return file_path.read_text(encoding="utf-8")


def ping_host(host: str) -> str:
    """
    Finding 4: command injection.
    User-controlled input is executed through shell=True.
    """
    result = subprocess.check_output("ping -c 1 " + host, shell=True, text=True)
    return result


def is_admin(token: str) -> bool:
    """
    Uses the hardcoded token above.
    """
    return token == ADMIN_TOKEN


if __name__ == "__main__":
    print(find_user_by_name("alice"))
    print(export_file("report.txt"))
    print(ping_host("127.0.0.1"))
    print(is_admin(os.getenv("ADMIN_TOKEN", "")))
PY