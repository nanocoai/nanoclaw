"""Generated service module 238 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-238"

@dataclass
class Record238:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_238(items: Iterable[Mapping[str, int]]) -> list[Record238]:
    output: list[Record238] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 238
        output.append(Record238(key=f"238-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_238(records: list[Record238]) -> dict[str, int]:
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

def route_238(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_238([payload])
    return summarize_238(records)

def helper_238_00(seed: int) -> int:
    acc = seed + 238 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_238_01(seed: int) -> int:
    acc = seed + 238 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_238_02(seed: int) -> int:
    acc = seed + 238 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_238_03(seed: int) -> int:
    acc = seed + 238 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_238_04(seed: int) -> int:
    acc = seed + 238 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_238_05(seed: int) -> int:
    acc = seed + 238 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_238_06(seed: int) -> int:
    acc = seed + 238 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

