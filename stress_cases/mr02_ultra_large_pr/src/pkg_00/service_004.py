"""Generated service module 004 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-004"

@dataclass
class Record004:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_004(items: Iterable[Mapping[str, int]]) -> list[Record004]:
    output: list[Record004] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 4
        output.append(Record004(key=f"004-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_004(records: list[Record004]) -> dict[str, int]:
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

def route_004(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_004([payload])
    return summarize_004(records)

def helper_004_00(seed: int) -> int:
    acc = seed + 4 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_004_01(seed: int) -> int:
    acc = seed + 4 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_004_02(seed: int) -> int:
    acc = seed + 4 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_004_03(seed: int) -> int:
    acc = seed + 4 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_004_04(seed: int) -> int:
    acc = seed + 4 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_004_05(seed: int) -> int:
    acc = seed + 4 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_004_06(seed: int) -> int:
    acc = seed + 4 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

