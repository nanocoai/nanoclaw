"""Generated service module 487 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-487"

@dataclass
class Record487:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_487(items: Iterable[Mapping[str, int]]) -> list[Record487]:
    output: list[Record487] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 487
        output.append(Record487(key=f"487-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_487(records: list[Record487]) -> dict[str, int]:
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

def route_487(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_487([payload])
    return summarize_487(records)

def helper_487_00(seed: int) -> int:
    acc = seed + 487 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_487_01(seed: int) -> int:
    acc = seed + 487 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_487_02(seed: int) -> int:
    acc = seed + 487 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_487_03(seed: int) -> int:
    acc = seed + 487 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_487_04(seed: int) -> int:
    acc = seed + 487 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_487_05(seed: int) -> int:
    acc = seed + 487 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_487_06(seed: int) -> int:
    acc = seed + 487 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

