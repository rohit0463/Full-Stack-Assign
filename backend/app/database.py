import os
import json
import sqlite3
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from app.config import settings


def get_db_path() -> str:
    db_url = settings.DATABASE_URL
    if db_url.startswith("sqlite:////"):
        path = "/" + db_url[len("sqlite:////"):]
    elif db_url.startswith("sqlite:///"):
        path = db_url[len("sqlite:///"): ]
    else:
        path = db_url

    # Ensure parent directory exists
    dir_name = os.path.dirname(path)
    if dir_name and not os.path.exists(dir_name):
        try:
            os.makedirs(dir_name, exist_ok=True)
        except OSError:
            pass
    return path


def get_connection() -> sqlite3.Connection:
    path = get_db_path()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    path = get_db_path()
    dir_name = os.path.dirname(path)
    if dir_name:
        os.makedirs(dir_name, exist_ok=True)
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL
            );
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);")
        conn.commit()


def add_message(session_id: str, role: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
    created_at = datetime.now(timezone.utc).isoformat()
    metadata_json = json.dumps(metadata) if metadata is not None else None
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO messages (session_id, role, content, metadata, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, role, content, metadata_json, created_at)
        )
        conn.commit()


def get_session_messages(session_id: str) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.execute(
            """
            SELECT role, content, metadata
            FROM messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,)
        )
        rows = cursor.fetchall()

    messages = []
    for row in rows:
        item: Dict[str, Any] = {
            "role": row["role"],
            "content": row["content"]
        }
        if row["metadata"]:
            try:
                meta = json.loads(row["metadata"])
                item["metadata"] = meta
            except Exception:
                pass
        messages.append(item)
    return messages


def session_exists(session_id: str) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "SELECT 1 FROM messages WHERE session_id = ? LIMIT 1",
            (session_id,)
        )
        return cursor.fetchone() is not None
