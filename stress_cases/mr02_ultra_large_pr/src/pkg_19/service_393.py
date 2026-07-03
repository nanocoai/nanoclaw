"""Generated service module 393 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-393"

@dataclass
class Record393:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_393(items: Iterable[Mapping[str, int]]) -> list[Record393]:
    output: list[Record393] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 393
        output.append(Record393(key=f"393-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_393(records: list[Record393]) -> dict[str, int]:
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

def route_393(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_393([payload])
    return summarize_393(records)

def helper_393_00(seed: int) -> int:
    acc = seed + 393 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_393_01(seed: int) -> int:
    acc = seed + 393 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_393_02(seed: int) -> int:
    acc = seed + 393 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_393_03(seed: int) -> int:
    acc = seed + 393 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_393_04(seed: int) -> int:
    acc = seed + 393 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_393_05(seed: int) -> int:
    acc = seed + 393 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_393_06(seed: int) -> int:
    acc = seed + 393 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

