//! The user's editable profile is separate from the replaceable system-skills cache.
use std::fs;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

pub const TEMPLATE: &str = include_str!("assets/personal/SKILL.md");
pub const TIP: &str = "Tell Elpis how you work: /personal";
const DISMISSED: &str = "personal-tip-dismissed";

pub fn path(home: &Path) -> PathBuf {
    home.join("skills/personal/SKILL.md")
}

pub fn show_tip(home: &Path) -> bool {
    !path(home).exists() && !home.join(DISMISSED).exists()
}

pub fn dismiss_tip(home: &Path) -> io::Result<()> {
    fs::create_dir_all(home)?;
    fs::write(home.join(DISMISSED), "")
}

/// Exclusive creation also preserves an existing file when two clients open it together.
pub fn open(home: &Path) -> io::Result<(PathBuf, String)> {
    let path = path(home);
    fs::create_dir_all(home.join("skills/personal"))?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => file.write_all(TEMPLATE.as_bytes())?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let content = read_content(&path)?;
    dismiss_tip(home)?;
    Ok((path, content))
}

/// Only a valid personal skill becomes context; cap the profile to a small instruction file.
pub fn read(home: &Path) -> io::Result<Option<String>> {
    let path = path(home);
    let content = match read_content(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = crate::parse_skill_frontmatter_metadata(&content, || "personal".into())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if metadata.name != "personal" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Expected a personal skill",
        ));
    }
    Ok(Some(content))
}

fn read_content(path: &Path) -> io::Result<String> {
    let mut content = String::new();
    fs::File::open(path)?
        .take(32 * 1024 + 1)
        .read_to_string(&mut content)?;
    if content.len() > 32 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Personal skill exceeds 32 KB",
        ));
    }
    Ok(content)
}
