"""Generated service module 141 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-141"

@dataclass
class Record141:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_141(items: Iterable[Mapping[str, int]]) -> list[Record141]:
    output: list[Record141] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 141
        output.append(Record141(key=f"141-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_141(records: list[Record141]) -> dict[str, int]:
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

def route_141(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_141([payload])
    return summarize_141(records)

def helper_141_00(seed: int) -> int:
    acc = seed + 141 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_141_01(seed: int) -> int:
    acc = seed + 141 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_141_02(seed: int) -> int:
    acc = seed + 141 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_141_03(seed: int) -> int:
    acc = seed + 141 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_141_04(seed: int) -> int:
    acc = seed + 141 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_141_05(seed: int) -> int:
    acc = seed + 141 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_141_06(seed: int) -> int:
    acc = seed + 141 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

