"""What the shell needs to know about a tool to host it."""

from dataclasses import dataclass

from fastapi import APIRouter


@dataclass(frozen=True)
class Tool:
    id: str
    path: str  # as this app sees it; the gateway prefix is added by url()
    name: str  # the <h1> of the pane
    nav: str  # the sidebar label — says what it DOES, not just what it is called
    icon: str  # inner markup of a 24x24 stroke SVG
    router: APIRouter
