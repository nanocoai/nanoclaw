# Customizing NanoClaw

NanoClaw is made to be forked and changed. The catch with most projects is that once you edit the code, every upstream update turns into a merge fight, and the more you customized, the worse it gets.

NanoClaw avoids that with one simple idea: **every change you make is a skill.**

## The idea in a minute

- A **skill** is a small, self-contained add-on. It brings its own code and knows how to install itself.
- Your **fork is just a list of skills**, plus one "recipe" that says which skills you have and how they fit together.
- Because your changes live beside the core instead of tangled into it, **pulling in updates stays easy**.

## What makes it work

A good skill mostly **adds** things: new files, a line appended to an existing file, a dependency. It avoids rewriting existing code in place.

And it ships a test for each spot where it touches the rest of the system. When an update moves something your skill depends on, that test fails and points at the fix, instead of you finding out when things break in production.

## How you actually work

You don't have to think in skills while you're building. **Edit the code directly, get it working, then turn your changes into skills afterward.** A coding agent does the conversion for you, following [skill-guidelines.md](skill-guidelines.md).

The only rule worth remembering: **a change isn't really part of your fork until it's a skill**, because that's the form that survives an upgrade.

## Upgrading

Always upgrade by running `/update-nanoclaw`. **Don't just `git pull`.** The command sets a rollback point, pulls the upstream changes, runs your tests, and walks you through anything that needs fixing, usually a small, local fix in one skill.

## The deal

We keep the core small and stable, and every breaking change ships with its migration. You keep your changes as skills, with tests. Do that, and upgrades won't break you. Changes edited directly into the core are the one thing the model can't protect.

## Go deeper

- **[The skills model in full](skills-model.md)**: how skills, recipes, tests, and upgrades work under the hood.
- **[Skill guidelines](skill-guidelines.md)**: the authoritative checklist for writing one.
