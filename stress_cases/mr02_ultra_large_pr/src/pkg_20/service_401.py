"""Generated service module 401 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-401"

@dataclass
class Record401:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_401(items: Iterable[Mapping[str, int]]) -> list[Record401]:
    output: list[Record401] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 401
        output.append(Record401(key=f"401-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_401(records: list[Record401]) -> dict[str, int]:
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

def route_401(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_401([payload])
    return summarize_401(records)

def helper_401_00(seed: int) -> int:
    acc = seed + 401 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_401_01(seed: int) -> int:
    acc = seed + 401 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_401_02(seed: int) -> int:
    acc = seed + 401 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_401_03(seed: int) -> int:
    acc = seed + 401 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_401_04(seed: int) -> int:
    acc = seed + 401 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_401_05(seed: int) -> int:
    acc = seed + 401 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_401_06(seed: int) -> int:
    acc = seed + 401 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

