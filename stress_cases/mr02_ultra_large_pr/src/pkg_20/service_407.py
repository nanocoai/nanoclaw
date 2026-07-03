"""Generated service module 407 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-407"

@dataclass
class Record407:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_407(items: Iterable[Mapping[str, int]]) -> list[Record407]:
    output: list[Record407] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 407
        output.append(Record407(key=f"407-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_407(records: list[Record407]) -> dict[str, int]:
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

def route_407(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_407([payload])
    return summarize_407(records)

def helper_407_00(seed: int) -> int:
    acc = seed + 407 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_407_01(seed: int) -> int:
    acc = seed + 407 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_407_02(seed: int) -> int:
    acc = seed + 407 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_407_03(seed: int) -> int:
    acc = seed + 407 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_407_04(seed: int) -> int:
    acc = seed + 407 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_407_05(seed: int) -> int:
    acc = seed + 407 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_407_06(seed: int) -> int:
    acc = seed + 407 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

