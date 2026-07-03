"""Generated service module 266 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-266"

@dataclass
class Record266:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_266(items: Iterable[Mapping[str, int]]) -> list[Record266]:
    output: list[Record266] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 266
        output.append(Record266(key=f"266-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_266(records: list[Record266]) -> dict[str, int]:
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

def route_266(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_266([payload])
    return summarize_266(records)

def helper_266_00(seed: int) -> int:
    acc = seed + 266 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_266_01(seed: int) -> int:
    acc = seed + 266 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_266_02(seed: int) -> int:
    acc = seed + 266 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_266_03(seed: int) -> int:
    acc = seed + 266 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_266_04(seed: int) -> int:
    acc = seed + 266 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_266_05(seed: int) -> int:
    acc = seed + 266 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_266_06(seed: int) -> int:
    acc = seed + 266 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

