"""Generated service module 257 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-257"

@dataclass
class Record257:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_257(items: Iterable[Mapping[str, int]]) -> list[Record257]:
    output: list[Record257] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 257
        output.append(Record257(key=f"257-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_257(records: list[Record257]) -> dict[str, int]:
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

def route_257(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_257([payload])
    return summarize_257(records)

def helper_257_00(seed: int) -> int:
    acc = seed + 257 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_257_01(seed: int) -> int:
    acc = seed + 257 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_257_02(seed: int) -> int:
    acc = seed + 257 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_257_03(seed: int) -> int:
    acc = seed + 257 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_257_04(seed: int) -> int:
    acc = seed + 257 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_257_05(seed: int) -> int:
    acc = seed + 257 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_257_06(seed: int) -> int:
    acc = seed + 257 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

