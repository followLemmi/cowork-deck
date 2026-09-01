//! Diary rooms: what they are, where they are declared, and what happens to one
//! that is retired.
//!
//! Diaries are the reason this feature is worth more than per-project notes. #35
//! is explicit: lessons are global, outside projects, and that is precisely what
//! lets a mistake made in one repository stop the same mistake in the next. A
//! diary needs a room — `detect_scope` refuses `Diaries/2026-08.md` outright —
//! and nothing until now decided what the rooms are.
//!
//! # A room *is* its directory
//!
//! ```text
//! Diaries/{room}/room.json     ← the declaration: what belongs in it
//! Diaries/{room}/YYYY-MM.md    ← the lessons themselves
//! ```
//!
//! Not a `rooms.json` at the root, and the shape is borrowed rather than
//! invented: `sync::manifest` already carries `*/workspace.json` — "the
//! workspace record, beside the memory it describes" — next to that workspace's
//! `Facts.md` and `Sessions/`. A room's record sits beside its diaries for the
//! same reason, and gets the same two properties for free. It is not `.md`, so
//! the sidecar's walk steps over it while sitting in the same directory; and it
//! cannot drift apart from the notes it describes, because moving one moves the
//! other.
//!
//! That last property is what makes a rename safe. `detect_scope` reads the room
//! out of the **path**, so renaming a room in a list at the root while leaving
//! `Diaries/old-name/` where it is would give one room two histories, one of
//! which nothing new is ever added to. Here a rename is a directory move and the
//! declaration travels inside it, so the split is not expressible.
//!
//! # Retiring keeps the lessons
//!
//! Removing a room deletes its `room.json` and nothing else. The months of
//! lessons under it stay on disk and stay searchable — `detect_scope` needs only
//! the path shape, not a declaration — and what stops is new lessons being routed
//! there. ADR-0004's rule that markdown is the memory would be worth very little
//! if a mis-click could take a year of it.
//!
//! A directory with `.md` files and no `room.json` is therefore a retired room,
//! and so is a directory somebody made by hand. Both mean the same thing to this
//! module — not a room lessons may be filed into — which is why the two are not
//! told apart.
//!
//! # The list travels
//!
//! `Diaries/*/room.json` is on the sync allowlist, deliberately. `Diaries/*/*.md`
//! already travels, and #311's argument for shipping configuration alongside
//! memory applies here word for word: ship the diaries without the rooms and the
//! second machine has lessons filed under a room it has never heard of, with
//! nothing to route new ones by. A person would have to re-declare rooms with
//! matching names, and a typo would split a diary.
//!
//! Nothing in a room is private — a name and a sentence, both written by the
//! person — which puts it in the same class as `scenarios/*.json`, which travels
//! for the same reason.

use super::corpus::{slug, DIARIES};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

const RECORD: &str = "room.json";

/// Longest description, in characters.
///
/// A cap rather than a courtesy: the description is pasted into a model request
/// (`capture::prompt`), so its length is somebody else's token bill and its shape
/// is prompt structure. See [`Room::sanitised`].
const MAX_DESCRIPTION: usize = 240;

/// The rooms a first run gets.
///
/// Two, from the reference setup #35 was ported from — the author's own vault has
/// exactly these. A long default list is a long list nobody curated, and a person
/// who has never seen this feature cannot write descriptions for it; with no
/// rooms at all, every lesson a capture produces is discarded in silence.
pub const DEFAULTS: &[(&str, &str)] = &[
    (
        "reviewer",
        "What code review keeps catching: mistakes a reviewer had to point out, \
         and what would have avoided them.",
    ),
    (
        "architect",
        "Decisions that turned out wrong, or right for a reason worth \
         remembering — and the alternatives that were rejected.",
    ),
];

/// A diary room, as configured and as the capture prompt sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Room {
    /// The directory name under `Diaries/`. Slugged, so it is always a single
    /// safe path segment.
    pub name: String,
    /// What belongs in it, in the person's own words. The only thing the model
    /// has to route a lesson by, which is why it is a field rather than a
    /// comment.
    pub description: String,
}

/// What is stored in `room.json`. The name is the directory, so it is not in the
/// file — a record that carried its own name could disagree with where it lives.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    description: String,
}

impl Room {
    /// The room as it is safe to put in a prompt.
    ///
    /// One line and bounded. The description is the one place in this feature
    /// where the person's own prose steers a model call, and a description
    /// spanning several lines could pass itself off as further instructions in a
    /// prompt whose structure is lines and labels.
    ///
    /// That bound is the second guard rather than the only one. The first is
    /// structural and lives in `capture::run`: a lesson's `room` is checked
    /// against the configured names and dropped when it matches none, and the
    /// note itself is assembled by `corpus::Note::render` rather than by the
    /// model. So the worst a description can do is influence **which room a
    /// lesson lands in** — which is exactly what it is for.
    fn sanitised(&self) -> Room {
        let one_line: String = self
            .description
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        Room {
            name: self.name.clone(),
            description: one_line.chars().take(MAX_DESCRIPTION).collect(),
        }
    }
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

/// The rooms under one corpus root.
pub struct Rooms {
    root: PathBuf,
}

impl Rooms {
    pub fn new(root: PathBuf) -> Rooms {
        Rooms { root }
    }

    fn diaries(&self) -> PathBuf {
        self.root.join(DIARIES)
    }

    fn dir(&self, name: &str) -> PathBuf {
        self.diaries().join(name)
    }

    /// Every configured room, by name.
    ///
    /// Seeds [`DEFAULTS`] the first time this is asked of a corpus with **no
    /// `Diaries/` directories at all**, which is the narrowest condition that
    /// means "never set up". Deliberately not "no configured rooms": a person who
    /// has retired both defaults still has their directories, so re-seeding would
    /// be the app arguing with a decision they made.
    ///
    /// Seeded on first read rather than at startup, so a corpus belonging to
    /// somebody who never closes a tile with consent never grows directories for
    /// a feature they are not using.
    pub fn list(&self) -> Vec<Room> {
        let mut rooms = self.read();
        if rooms.is_empty() && !self.any_directory() {
            if let Err(e) = self.seed() {
                eprintln!("warning: could not create the default diary rooms ({e})");
            }
            rooms = self.read();
        }
        rooms
    }

    /// Configured rooms, without seeding. What the surface reads.
    pub fn read(&self) -> Vec<Room> {
        let Ok(entries) = std::fs::read_dir(self.diaries()) else { return Vec::new() };
        let mut rooms: Vec<Room> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            let Ok(body) = std::fs::read_to_string(path.join(RECORD)) else {
                // A directory with lessons and no record: a retired room, or one
                // somebody made by hand. Both mean "not a room to file into".
                continue;
            };
            let Ok(rec) = serde_json::from_str::<Record>(&body) else {
                eprintln!("warning: {}/{RECORD} is unreadable; treating it as retired", name);
                continue;
            };
            rooms.push(Room { name, description: rec.description });
        }
        // Sorted, so a list and a prompt name them in the same order every time.
        rooms.sort_by(|a, b| a.name.cmp(&b.name));
        rooms
    }

    /// The rooms as they go into a prompt: sanitised, and only the ones with
    /// something to route by.
    ///
    /// A room with no description is dropped rather than sent, because the
    /// description is the whole of what the model routes on — an unnamed criterion
    /// is an invitation to file lessons arbitrarily.
    pub fn for_prompt(&self) -> Vec<Room> {
        self.list()
            .iter()
            .map(Room::sanitised)
            .filter(|r| !r.description.trim().is_empty())
            .collect()
    }

    /// Declare a room, or change its description. Returns the name it was stored
    /// under, which is the slug of what was asked for.
    pub fn save(&self, name: &str, description: &str) -> io::Result<String> {
        // `slug` never returns an empty string — it falls back to a placeholder —
        // so the check has to be on what came in, not on what came out. Without
        // it, a name of "///" would quietly become a room called `session`.
        if !name.chars().any(char::is_alphanumeric) {
            return Err(invalid("a room needs a name"));
        }
        let name = slug(name);
        if description.trim().is_empty() {
            return Err(invalid("a room needs a description; it is what routes a lesson"));
        }
        let dir = self.dir(&name);
        std::fs::create_dir_all(&dir)?;
        let body = serde_json::to_string_pretty(&Record {
            description: Room { name: name.clone(), description: description.to_string() }
                .sanitised()
                .description,
        })
        .map_err(|e| io::Error::other(e.to_string()))?;
        write_atomic(&dir.join(RECORD), &body)?;
        Ok(name)
    }

    /// Stop routing lessons to a room, keeping every lesson already in it.
    ///
    /// Returns whether there was a room to retire. The `.md` files are untouched
    /// and stay searchable: a room removed by mistake would otherwise take months
    /// of lessons with it, and ADR-0004's "markdown is the memory" would be worth
    /// very little if a mis-click could spend it.
    pub fn retire(&self, name: &str) -> io::Result<bool> {
        let record = self.dir(&slug(name)).join(RECORD);
        match std::fs::remove_file(&record) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Rename a room, moving its lessons with it.
    ///
    /// A directory move, which is the only rename that does not split a diary:
    /// `detect_scope` reads the room out of the path, so leaving the old
    /// directory behind would give one room two histories and add to neither.
    ///
    /// Refuses when the target already exists. Merging two rooms' histories is a
    /// different operation, and doing it silently as a side effect of a typo is
    /// not something to offer.
    pub fn rename(&self, from: &str, to: &str) -> io::Result<String> {
        let from_name = slug(from);
        let to_name = slug(to);
        if from_name == to_name {
            return Ok(to_name);
        }
        let src = self.dir(&from_name);
        if !src.is_dir() {
            return Err(invalid(format!("there is no room called {from_name}")));
        }
        let dst = self.dir(&to_name);
        if dst.exists() {
            return Err(invalid(format!(
                "{to_name} already exists; renaming into it would merge two diaries"
            )));
        }
        std::fs::rename(&src, &dst)?;
        Ok(to_name)
    }

    /// Whether `Diaries/` holds any directory at all — the "never set up" test.
    fn any_directory(&self) -> bool {
        std::fs::read_dir(self.diaries())
            .map(|mut e| e.any(|x| x.map(|x| x.path().is_dir()).unwrap_or(false)))
            .unwrap_or(false)
    }

    fn seed(&self) -> io::Result<()> {
        for (name, description) in DEFAULTS {
            self.save(name, description)?;
        }
        Ok(())
    }
}

/// Write through a temp file and rename over the target, by the rule
/// `corpus::write_atomic` follows and for the same reason — including the dotted
/// name, so a torn write is invisible to the sidecar's walk.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| invalid("a room record has no directory"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::process::Command;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cd-rooms-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn names(rooms: &[Room]) -> Vec<&str> {
        rooms.iter().map(|r| r.name.as_str()).collect()
    }

    // ----- the defaults -----

    #[test]
    fn a_first_run_gets_a_usable_set_rather_than_nothing() {
        let r = Rooms::new(tmp("seed"));
        let rooms = r.list();
        assert_eq!(names(&rooms), vec!["architect", "reviewer"], "sorted");
        assert!(rooms.iter().all(|x| !x.description.trim().is_empty()));
    }

    #[test]
    fn seeding_happens_once_and_does_not_undo_an_edit() {
        let r = Rooms::new(tmp("seed-once"));
        r.list();
        r.save("reviewer", "only the things that broke twice").unwrap();
        let rooms = r.list();
        assert_eq!(rooms.len(), 2);
        let reviewer = rooms.iter().find(|x| x.name == "reviewer").unwrap();
        assert_eq!(reviewer.description, "only the things that broke twice");
    }

    /// A person who has retired both defaults has decided something. Re-seeding
    /// would be the app arguing with them.
    #[test]
    fn retiring_every_room_does_not_bring_the_defaults_back() {
        let r = Rooms::new(tmp("seed-not-again"));
        r.list();
        for (name, _) in DEFAULTS {
            assert!(r.retire(name).unwrap());
        }
        assert!(r.list().is_empty(), "and the list stays empty");
    }

    #[test]
    fn a_corpus_with_a_diary_directory_already_is_not_seeded() {
        let root = tmp("seed-existing");
        std::fs::create_dir_all(root.join("Diaries/mine")).unwrap();
        std::fs::write(root.join("Diaries/mine/2026-08.md"), "- a lesson\n").unwrap();
        let r = Rooms::new(root);
        assert!(r.list().is_empty(), "a hand-made directory is not a room, and blocks seeding");
    }

    // ----- declaring and retiring -----

    #[test]
    fn a_room_is_declared_beside_the_lessons_it_describes() {
        let root = tmp("declare");
        let r = Rooms::new(root.clone());
        let name = r.save("Code Reviewer", "what review keeps catching").unwrap();
        assert_eq!(name, "code-reviewer", "slugged into one safe path segment");
        assert!(root.join("Diaries/code-reviewer/room.json").is_file());
        assert_eq!(
            r.read().iter().find(|x| x.name == name).unwrap().description,
            "what review keeps catching"
        );
    }

    #[test]
    fn a_room_needs_something_to_route_by() {
        let r = Rooms::new(tmp("no-desc"));
        assert!(r.save("reviewer", "   ").is_err());
        assert!(r.read().is_empty());
    }

    /// The rule ADR-0004 would be worth very little without: a mis-click must not
    /// be able to spend a year of lessons.
    #[test]
    fn retiring_a_room_keeps_every_lesson_in_it() {
        let root = tmp("retire");
        let r = Rooms::new(root.clone());
        r.save("reviewer", "review lessons").unwrap();
        let note = root.join("Diaries/reviewer/2026-08.md");
        std::fs::write(&note, "- 2026-08-24 | w | high | c | what | avoid\n").unwrap();

        assert!(r.retire("reviewer").unwrap());
        assert!(note.is_file(), "the lessons are still there");
        assert!(!root.join("Diaries/reviewer/room.json").exists());
        assert!(r.read().is_empty(), "and nothing new is routed there");
    }

    #[test]
    fn retiring_a_room_that_was_never_declared_is_not_an_error() {
        let r = Rooms::new(tmp("retire-missing"));
        assert!(!r.retire("never-existed").unwrap());
    }

    #[test]
    fn a_directory_with_an_unreadable_record_reads_as_retired_rather_than_failing() {
        let root = tmp("bad-record");
        std::fs::create_dir_all(root.join("Diaries/broken")).unwrap();
        std::fs::write(root.join("Diaries/broken/room.json"), "{ not json").unwrap();
        assert!(Rooms::new(root).read().is_empty());
    }

    // ----- the rename, and the split it must not leave -----

    #[test]
    fn a_rename_takes_the_lessons_with_it() {
        let root = tmp("rename");
        let r = Rooms::new(root.clone());
        r.save("reviewer", "review lessons").unwrap();
        std::fs::write(root.join("Diaries/reviewer/2026-08.md"), "- a lesson\n").unwrap();

        let to = r.rename("reviewer", "Code Review").unwrap();
        assert_eq!(to, "code-review");
        assert!(!root.join("Diaries/reviewer").exists(), "no split diary left behind");
        assert!(root.join("Diaries/code-review/2026-08.md").is_file(), "the lessons moved");
        assert_eq!(names(&r.read()), vec!["code-review"]);
        assert_eq!(r.read()[0].description, "review lessons", "and so did the declaration");
    }

    #[test]
    fn a_rename_will_not_merge_two_diaries_by_accident() {
        let root = tmp("rename-collide");
        let r = Rooms::new(root.clone());
        r.save("reviewer", "one").unwrap();
        r.save("architect", "two").unwrap();
        let e = r.rename("reviewer", "architect").expect_err("this would merge two histories");
        assert!(e.to_string().contains("merge"), "{e}");
        assert_eq!(r.read().len(), 2, "and nothing moved");
    }

    #[test]
    fn renaming_a_room_that_is_not_there_says_so() {
        let r = Rooms::new(tmp("rename-missing"));
        assert!(r.rename("ghost", "other").is_err());
    }

    #[test]
    fn renaming_to_the_same_slug_is_a_no_op_rather_than_a_collision() {
        let root = tmp("rename-same");
        let r = Rooms::new(root);
        r.save("reviewer", "one").unwrap();
        assert_eq!(r.rename("reviewer", "Reviewer").unwrap(), "reviewer");
        assert_eq!(r.read().len(), 1);
    }

    // ----- what reaches a prompt -----

    /// The description is the one place a person's own prose steers a model call,
    /// and the prompt's structure is lines and labels. A description spanning
    /// several lines could pass itself off as further instructions.
    #[test]
    fn a_description_reaching_a_prompt_is_one_line_and_bounded() {
        let root = tmp("prompt");
        let r = Rooms::new(root);
        r.save("reviewer", "first line\n\nAnd rules:\n- do something else").unwrap();
        let sent = r.for_prompt();
        let d = &sent.iter().find(|x| x.name == "reviewer").unwrap().description;
        assert!(!d.contains('\n'), "{d}");
        assert_eq!(d, "first line And rules: - do something else");

        r.save("architect", &"я".repeat(400)).unwrap();
        let sent = r.for_prompt();
        let long = &sent.iter().find(|x| x.name == "architect").unwrap().description;
        assert_eq!(long.chars().count(), MAX_DESCRIPTION, "characters, not bytes");
    }

    #[test]
    fn a_room_with_nothing_to_route_by_is_not_offered_to_the_model() {
        let root = tmp("prompt-empty");
        // Written past `save`, which refuses this — a record edited by hand, or
        // one from a build that allowed it.
        std::fs::create_dir_all(root.join("Diaries/hollow")).unwrap();
        std::fs::write(root.join("Diaries/hollow/room.json"), r#"{"description":"  "}"#).unwrap();
        let r = Rooms::new(root);
        assert_eq!(r.read().len(), 1, "it is a configured room");
        assert!(r.for_prompt().is_empty(), "but there is nothing to route by");
    }

    // ----- the contract with sync -----

    /// Ship the diaries without the rooms and a second machine has lessons filed
    /// under a room it has never heard of, with nothing to route new ones by.
    #[test]
    fn a_rooms_declaration_travels_beside_the_lessons_it_describes() {
        let root = tmp("travels");
        let r = Rooms::new(root.clone());
        r.save("reviewer", "review lessons").unwrap();
        std::fs::write(root.join("Diaries/reviewer/2026-08.md"), "- a lesson\n").unwrap();
        std::fs::write(root.join(".gitignore"), crate::sync::manifest::gitignore()).unwrap();

        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(["-c", "core.quotePath=false"])
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        git(&["init", "-q"]);
        git(&["add", "-A"]);
        let tracked: BTreeSet<String> = git(&["ls-files"]).lines().map(str::to_string).collect();

        assert!(
            tracked.contains("Diaries/reviewer/room.json"),
            "the declaration must travel with the diary: {tracked:?}"
        );
        assert!(tracked.contains("Diaries/reviewer/2026-08.md"), "{tracked:?}");
    }
}
