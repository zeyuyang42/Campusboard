//! Library database backup: the frontend writes a snapshot with `VACUUM INTO` to
//! `$APPDATA/backup-<ms>.tmp.db`; `backup_library` asks where to save it (native save
//! dialog), checks the destination and copies the snapshot there atomically.
//!
//! The destination check works on resolved paths and file identities, not strings: the
//! parent folder is canonicalized (case variants, `/System/Volumes/Data` firmlinks and
//! symlinks all resolve), a symlink as the final component is followed, and every
//! ancestor of the real target folder is compared by (device, inode) with the app's
//! data and config folders. Any target that is, or would be, the live database or its
//! `-wal`/`-shm`/`-journal` file is refused too (also by identity, so hard links count).

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

const INSIDE: &str = "Choose a place outside the app's data folder for the backup.";
const LIVE: &str = "That file is the library itself. Choose a different name or place for the backup.";

#[cfg(unix)]
fn file_id(p: &Path) -> Option<(u64, u64)> {
    fs::metadata(p).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn file_id(p: &Path) -> Option<(u64, u64)> {
    // Best effort elsewhere: canonical path text, lowercased (macOS is the target).
    let c = fs::canonicalize(p).ok()?;
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    c.to_string_lossy().to_lowercase().hash(&mut h);
    Some((0, h.finish()))
}

/// Resolve and check a backup destination. Returns the real path to write.
pub fn check_dest(dest: &Path, protected_dirs: &[PathBuf], live_files: &[PathBuf]) -> Result<PathBuf, String> {
    if !dest.is_absolute() {
        return Err("The backup path must be absolute.".into());
    }
    let name = dest.file_name().ok_or("Choose a file name for the backup.")?;
    let parent = dest.parent().ok_or("Choose a file name for the backup.")?;
    let parent = fs::canonicalize(parent).map_err(|e| format!("The folder for the backup isn't available ({e})."))?;
    let joined = parent.join(name);
    let target = match fs::symlink_metadata(&joined) {
        // Follow a symlink to wherever it really points (a dangling one is refused).
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(&joined).map_err(|_| "That file is a broken link. Choose another name.".to_string())?,
        Ok(m) if m.is_dir() => return Err("That is a folder. Choose a file name for the backup.".into()),
        _ => joined,
    };
    if fs::metadata(&target).map(|m| m.is_dir()).unwrap_or(false) {
        return Err("That is a folder. Choose a file name for the backup.".into());
    }
    let tparent = target.parent().ok_or("Choose a file name for the backup.")?;
    let tparent_id = file_id(tparent);
    let protected: Vec<(u64, u64)> = protected_dirs.iter().filter_map(|d| file_id(d)).collect();
    for anc in tparent.ancestors() {
        if let Some(id) = file_id(anc) {
            if protected.contains(&id) {
                return Err(INSIDE.into());
            }
        }
    }
    let target_id = file_id(&target);
    let tname = target.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    for live in live_files {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let f = PathBuf::from(format!("{}{suffix}", live.display()));
            if target_id.is_some() && target_id == file_id(&f) {
                return Err(LIVE.into());
            }
            // Not there yet (no -wal at this moment, say): same folder and name, any case.
            if let (Some(lp), Some(ln)) = (f.parent(), f.file_name()) {
                if tparent_id.is_some() && file_id(lp) == tparent_id && ln.to_string_lossy().to_lowercase() == tname {
                    return Err(LIVE.into());
                }
            }
        }
    }
    Ok(target)
}

/// Copy `src` to `target` through a temporary file in the same folder, flushed and then
/// renamed over the target, so a failure never leaves a partial backup behind.
pub fn atomic_copy(src: &Path, target: &Path) -> io::Result<u64> {
    let dir = target.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent folder"))?;
    let name = target.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let partial = dir.join(format!(".{}.partial-{}-{nanos}", name.to_string_lossy(), std::process::id()));
    let result = (|| {
        let mut from = File::open(src)?;
        let mut to = OpenOptions::new().write(true).create_new(true).open(&partial)?;
        let n = io::copy(&mut from, &mut to)?;
        to.sync_all()?;
        drop(to);
        fs::rename(&partial, target)?;
        Ok(n)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

/// `backup-<digits>.tmp.db`, the only snapshot names the frontend may hand over.
pub fn is_snapshot_name(name: &str) -> bool {
    name.strip_prefix("backup-")
        .and_then(|r| r.strip_suffix(".tmp.db"))
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// Remove snapshots left by a backup that was interrupted (app killed during VACUUM INTO).
/// Only ones older than an hour, so a backup running in another instance is left alone.
pub fn sweep_snapshots(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        if !is_snapshot_name(&name.to_string_lossy()) {
            continue;
        }
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(3600));
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("bcp-backup-test-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&p).unwrap();
            Scratch(fs::canonicalize(p).unwrap())
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// An app data folder holding a live database, and a folder outside it.
    fn setup(tag: &str) -> (Scratch, PathBuf, PathBuf, PathBuf) {
        let s = Scratch::new(tag);
        let app = s.0.join("com.example.app");
        let out = s.0.join("Backups");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&out).unwrap();
        let live = app.join("library.db");
        fs::write(&live, b"live").unwrap();
        fs::write(app.join("library.db-wal"), b"wal").unwrap();
        (s, app, out, live)
    }

    #[test]
    fn allows_a_file_outside_the_data_folder() {
        let (_s, app, out, live) = setup("ok");
        let t = check_dest(&out.join("backup.db"), &[app], &[live]).unwrap();
        assert_eq!(t, out.join("backup.db"));
    }

    #[test]
    fn refuses_the_data_folder_and_anything_below_it() {
        let (_s, app, _out, live) = setup("inside");
        fs::create_dir_all(app.join("sub")).unwrap();
        for p in [app.join("copy.db"), app.join("sub/copy.db"), app.join("library.db")] {
            assert_eq!(check_dest(&p, &[app.clone()], &[live.clone()]).unwrap_err(), INSIDE, "{p:?}");
        }
    }

    #[test]
    fn refuses_case_variants_and_dot_dot() {
        let (_s, app, out, live) = setup("case");
        // APFS is case-insensitive by default; on a case-sensitive volume the folder doesn't exist.
        let upper = PathBuf::from(app.to_string_lossy().replace("com.example.app", "COM.EXAMPLE.APP")).join("library.db");
        if upper.parent().unwrap().exists() {
            assert!(check_dest(&upper, &[app.clone()], &[live.clone()]).is_err());
        }
        let dotdot = out.join("..").join("com.example.app").join("x.db");
        assert_eq!(check_dest(&dotdot, &[app], &[live]).unwrap_err(), INSIDE);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_into_the_data_folder() {
        let (_s, app, out, live) = setup("link");
        let dir_link = out.join("innocent");
        std::os::unix::fs::symlink(&app, &dir_link).unwrap();
        assert_eq!(check_dest(&dir_link.join("library.db"), &[app.clone()], &[live.clone()]).unwrap_err(), INSIDE);
        let file_link = out.join("backup.db");
        std::os::unix::fs::symlink(&live, &file_link).unwrap();
        assert!(check_dest(&file_link, &[app.clone()], &[live.clone()]).is_err());
        let dangling = out.join("gone.db");
        std::os::unix::fs::symlink(out.join("nothing-here"), &dangling).unwrap();
        assert!(check_dest(&dangling, &[app], &[live]).is_err());
    }

    #[test]
    fn refuses_the_live_database_and_its_side_files_wherever_it_lives() {
        // A live database outside the protected folders (BCP_DB_PATH in dev builds).
        let (_s, app, out, _live) = setup("live");
        let live = out.join("scratch.db");
        fs::write(&live, b"live").unwrap();
        for name in ["scratch.db", "SCRATCH.DB", "scratch.db-wal", "scratch.db-shm", "scratch.db-journal"] {
            assert_eq!(check_dest(&out.join(name), &[app.clone()], &[live.clone()]).unwrap_err(), LIVE, "{name}");
        }
        #[cfg(unix)]
        {
            let hard = out.join("hardlink.db");
            fs::hard_link(&live, &hard).unwrap();
            assert_eq!(check_dest(&hard, &[app.clone()], &[live.clone()]).unwrap_err(), LIVE);
        }
        assert!(check_dest(&out.join("other.db"), &[app], &[live]).is_ok());
    }

    #[test]
    fn refuses_relative_paths_and_folders() {
        let (_s, app, out, live) = setup("misc");
        assert!(check_dest(Path::new("backup.db"), &[app.clone()], &[live.clone()]).is_err());
        assert!(check_dest(&out, &[app.clone()], &[live.clone()]).is_err());
        assert!(check_dest(&out.join("missing-folder/backup.db"), &[app], &[live]).is_err());
    }

    #[test]
    fn copies_atomically_and_replaces_an_existing_file() {
        let (_s, _app, out, _live) = setup("copy");
        let src = out.join("snap.tmp");
        fs::write(&src, b"SQLite format 3\0rest").unwrap();
        let target = out.join("backup.db");
        fs::write(&target, b"old").unwrap();
        assert_eq!(atomic_copy(&src, &target).unwrap(), 20);
        assert_eq!(fs::read(&target).unwrap(), b"SQLite format 3\0rest");
        let leftovers: Vec<_> = fs::read_dir(&out).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".partial-")).collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn a_failed_copy_leaves_nothing_behind() {
        let (_s, _app, out, _live) = setup("fail");
        let target = out.join("backup.db");
        assert!(atomic_copy(&out.join("no-such-snapshot"), &target).is_err());
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
    }

    #[test]
    fn recognises_snapshot_names_and_sweeps_only_old_ones() {
        assert!(is_snapshot_name("backup-1760000000000.tmp.db"));
        for bad in ["backup-.tmp.db", "backup-12a.tmp.db", "../backup-1.tmp.db", "library.db", "backup-1.db"] {
            assert!(!is_snapshot_name(bad), "{bad}");
        }
        let (_s, app, _out, _live) = setup("sweep");
        let fresh = app.join("backup-2.tmp.db");
        fs::write(&fresh, b"x").unwrap();
        sweep_snapshots(&app);
        assert!(fresh.exists(), "a snapshot from the last hour stays");
        assert!(app.join("library.db").exists());
    }
}
