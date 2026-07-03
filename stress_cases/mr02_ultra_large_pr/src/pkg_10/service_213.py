"""Generated service module 213 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-213"

@dataclass
class Record213:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_213(items: Iterable[Mapping[str, int]]) -> list[Record213]:
    output: list[Record213] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 213
        output.append(Record213(key=f"213-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_213(records: list[Record213]) -> dict[str, int]:
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

def route_213(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_213([payload])
    return summarize_213(records)

def helper_213_00(seed: int) -> int:
    acc = seed + 213 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_213_01(seed: int) -> int:
    acc = seed + 213 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_213_02(seed: int) -> int:
    acc = seed + 213 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_213_03(seed: int) -> int:
    acc = seed + 213 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_213_04(seed: int) -> int:
    acc = seed + 213 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_213_05(seed: int) -> int:
    acc = seed + 213 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_213_06(seed: int) -> int:
    acc = seed + 213 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

