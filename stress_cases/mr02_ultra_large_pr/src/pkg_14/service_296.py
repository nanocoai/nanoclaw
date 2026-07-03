"""Generated service module 296 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-296"

@dataclass
class Record296:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_296(items: Iterable[Mapping[str, int]]) -> list[Record296]:
    output: list[Record296] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 296
        output.append(Record296(key=f"296-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_296(records: list[Record296]) -> dict[str, int]:
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

def route_296(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_296([payload])
    return summarize_296(records)

def helper_296_00(seed: int) -> int:
    acc = seed + 296 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_296_01(seed: int) -> int:
    acc = seed + 296 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_296_02(seed: int) -> int:
    acc = seed + 296 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_296_03(seed: int) -> int:
    acc = seed + 296 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_296_04(seed: int) -> int:
    acc = seed + 296 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_296_05(seed: int) -> int:
    acc = seed + 296 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_296_06(seed: int) -> int:
    acc = seed + 296 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

