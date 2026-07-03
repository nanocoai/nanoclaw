"""Generated service module 036 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-036"

@dataclass
class Record036:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_036(items: Iterable[Mapping[str, int]]) -> list[Record036]:
    output: list[Record036] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 36
        output.append(Record036(key=f"036-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_036(records: list[Record036]) -> dict[str, int]:
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

def route_036(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_036([payload])
    return summarize_036(records)

def helper_036_00(seed: int) -> int:
    acc = seed + 36 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_036_01(seed: int) -> int:
    acc = seed + 36 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_036_02(seed: int) -> int:
    acc = seed + 36 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_036_03(seed: int) -> int:
    acc = seed + 36 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_036_04(seed: int) -> int:
    acc = seed + 36 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_036_05(seed: int) -> int:
    acc = seed + 36 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_036_06(seed: int) -> int:
    acc = seed + 36 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

