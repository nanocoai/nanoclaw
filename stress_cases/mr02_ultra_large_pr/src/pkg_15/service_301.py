"""Generated service module 301 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-301"

@dataclass
class Record301:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_301(items: Iterable[Mapping[str, int]]) -> list[Record301]:
    output: list[Record301] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 301
        output.append(Record301(key=f"301-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_301(records: list[Record301]) -> dict[str, int]:
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

def route_301(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_301([payload])
    return summarize_301(records)

def helper_301_00(seed: int) -> int:
    acc = seed + 301 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_301_01(seed: int) -> int:
    acc = seed + 301 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_301_02(seed: int) -> int:
    acc = seed + 301 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_301_03(seed: int) -> int:
    acc = seed + 301 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_301_04(seed: int) -> int:
    acc = seed + 301 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_301_05(seed: int) -> int:
    acc = seed + 301 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_301_06(seed: int) -> int:
    acc = seed + 301 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

