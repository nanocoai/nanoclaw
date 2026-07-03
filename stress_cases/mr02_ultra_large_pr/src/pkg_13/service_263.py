"""Generated service module 263 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-263"

@dataclass
class Record263:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_263(items: Iterable[Mapping[str, int]]) -> list[Record263]:
    output: list[Record263] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 263
        output.append(Record263(key=f"263-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_263(records: list[Record263]) -> dict[str, int]:
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

def route_263(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_263([payload])
    return summarize_263(records)

def helper_263_00(seed: int) -> int:
    acc = seed + 263 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_263_01(seed: int) -> int:
    acc = seed + 263 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_263_02(seed: int) -> int:
    acc = seed + 263 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_263_03(seed: int) -> int:
    acc = seed + 263 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_263_04(seed: int) -> int:
    acc = seed + 263 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_263_05(seed: int) -> int:
    acc = seed + 263 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_263_06(seed: int) -> int:
    acc = seed + 263 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

