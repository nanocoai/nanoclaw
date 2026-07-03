"""Generated service module 236 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-236"

@dataclass
class Record236:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_236(items: Iterable[Mapping[str, int]]) -> list[Record236]:
    output: list[Record236] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 236
        output.append(Record236(key=f"236-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_236(records: list[Record236]) -> dict[str, int]:
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

def route_236(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_236([payload])
    return summarize_236(records)

def helper_236_00(seed: int) -> int:
    acc = seed + 236 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_236_01(seed: int) -> int:
    acc = seed + 236 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_236_02(seed: int) -> int:
    acc = seed + 236 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_236_03(seed: int) -> int:
    acc = seed + 236 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_236_04(seed: int) -> int:
    acc = seed + 236 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_236_05(seed: int) -> int:
    acc = seed + 236 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_236_06(seed: int) -> int:
    acc = seed + 236 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

