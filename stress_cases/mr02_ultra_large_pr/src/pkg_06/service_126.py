"""Generated service module 126 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-126"

@dataclass
class Record126:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_126(items: Iterable[Mapping[str, int]]) -> list[Record126]:
    output: list[Record126] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 126
        output.append(Record126(key=f"126-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_126(records: list[Record126]) -> dict[str, int]:
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

def route_126(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_126([payload])
    return summarize_126(records)

def helper_126_00(seed: int) -> int:
    acc = seed + 126 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_126_01(seed: int) -> int:
    acc = seed + 126 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_126_02(seed: int) -> int:
    acc = seed + 126 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_126_03(seed: int) -> int:
    acc = seed + 126 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_126_04(seed: int) -> int:
    acc = seed + 126 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_126_05(seed: int) -> int:
    acc = seed + 126 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_126_06(seed: int) -> int:
    acc = seed + 126 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

