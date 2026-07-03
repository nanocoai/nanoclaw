"""Generated service module 402 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-402"

@dataclass
class Record402:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_402(items: Iterable[Mapping[str, int]]) -> list[Record402]:
    output: list[Record402] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 402
        output.append(Record402(key=f"402-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_402(records: list[Record402]) -> dict[str, int]:
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

def route_402(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_402([payload])
    return summarize_402(records)

def helper_402_00(seed: int) -> int:
    acc = seed + 402 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_402_01(seed: int) -> int:
    acc = seed + 402 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_402_02(seed: int) -> int:
    acc = seed + 402 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_402_03(seed: int) -> int:
    acc = seed + 402 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_402_04(seed: int) -> int:
    acc = seed + 402 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_402_05(seed: int) -> int:
    acc = seed + 402 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_402_06(seed: int) -> int:
    acc = seed + 402 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

