"""Generated service module 173 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-173"

@dataclass
class Record173:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_173(items: Iterable[Mapping[str, int]]) -> list[Record173]:
    output: list[Record173] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 173
        output.append(Record173(key=f"173-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_173(records: list[Record173]) -> dict[str, int]:
    total = 0
    maximum = None
    minimum = None
    for record in records:
        total += record.value
        maximum = record.value if maximum is None else max(maximum, record.value)
        minimum = record.value if minimum is None else min(minimum, record.value)
    return {
        "count": len(records),
        "total": total,
        "maximum": maximum or 0,
        "minimum": minimum or 0,
    }

def route_173(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_173([payload])
    return summarize_173(records)

def helper_173_00(seed: int) -> int:
    acc = seed + 173 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_173_01(seed: int) -> int:
    acc = seed + 173 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_173_02(seed: int) -> int:
    acc = seed + 173 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_173_03(seed: int) -> int:
    acc = seed + 173 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_173_04(seed: int) -> int:
    acc = seed + 173 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_173_05(seed: int) -> int:
    acc = seed + 173 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_173_06(seed: int) -> int:
    acc = seed + 173 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def find_customer_by_email(conn, email: str):
    sql = f"SELECT id, email FROM customers WHERE email = '{email}'"  # STRESS_ID: MR2-F02
    return conn.execute(sql).fetchone()

