use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};

use openidea_plugin::views::{View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, Position, Range, host, register_plugin};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::Deserialize;

const VIEW: &str = "live-preview";
const DEFAULT_PREVIEW_SIZE: i8 = 13;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Request {
    Url { href: String },
    File { path: String, anchor: String },
    ReadZoom,
    AdjustZoom { step: i8 },
    Attach { token: String },
    StoreHistory { state: serde_json::Value },
}

#[derive(Default)]
struct Navigation {
    history: VecDeque<(PathBuf, serde_json::Value)>,
    anchors: HashMap<PathBuf, String>,
}

impl Plugin for Navigation {
    fn run_command(
        &mut self,
        id: &str,
        _: &Invocation,
        _: Option<&str>,
    ) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}

impl Views for Navigation {
    fn render(&mut self, _view: &str, _: Option<Viewport>, _: &Invocation) -> Result<View, Error> {
        Ok(View::message("Markdown Live Preview"))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Ok(());
        }
        let ViewEvent::Message(message) = event else {
            return Ok(());
        };
        let request =
            serde_json::from_str(&message).map_err(|err| Error::Invalid(err.to_string()))?;
        if let Err(error) = self.handle_request(request, ctx) {
            host::post_view_message(view, &error.to_string())?;
        }
        Ok(())
    }
}

impl Navigation {
    fn handle_request(&mut self, request: Request, ctx: &Invocation) -> Result<(), Error> {
        match &request {
            Request::ReadZoom => return preview_zoom(None),
            Request::AdjustZoom { step } if (-1..=1).contains(step) => {
                return preview_zoom(Some(*step));
            }
            Request::AdjustZoom { .. } => {
                return Err(Error::Invalid("Invalid preview zoom step".into()));
            }
            _ => {}
        }
        if let Request::Url { href } = &request {
            if href.starts_with("https://") || href.starts_with("http://") {
                return host::open_url(href);
            }
            return Err(Error::Invalid(
                "Only HTTP and HTTPS links can open in the browser".into(),
            ));
        }
        let path = ctx
            .editor()
            .ok_or_else(|| Error::Invalid("No Markdown document is open".into()))?
            .path();
        let current = normalize_path(Path::new(&path));
        match request {
            Request::Attach { token } => {
                let anchor = self.anchors.remove(&current);
                let state = self
                    .history
                    .iter()
                    .find(|(path, _)| path == &current)
                    .map(|(_, state)| state);
                host::post_view_message(
                    VIEW,
                    &serde_json::json!({
                        "kind": "preview-context", "token": token, "path": current,
                        "state": state, "anchor": anchor,
                    })
                    .to_string(),
                )
            }
            Request::StoreHistory { state } => {
                // View messages have a bounded transport size. Retain recent editors
                // while their frames are closed, without accumulating file snapshots.
                if let Some(index) = self.history.iter().position(|(path, _)| path == &current) {
                    self.history.remove(index);
                } else if self.history.len() == 24 {
                    self.history.pop_front();
                }
                self.history.push_back((current, state));
                Ok(())
            }
            Request::File { path, anchor } => {
                if path.is_empty()
                    || path.starts_with('/')
                    || path.contains(['\\', ':'])
                    || path.chars().any(char::is_control)
                {
                    return Err(Error::Invalid(
                        "Expected a relative project file link".into(),
                    ));
                }
                let parent = current
                    .parent()
                    .ok_or_else(|| Error::Invalid("Cannot resolve the relative link".into()))?;
                let target_path = parent.join(path);
                let target = target_path
                    .to_str()
                    .ok_or_else(|| Error::Invalid("Invalid file name".into()))?;
                // The host checks that the canonical path is inside the project before opening it.
                let selection = if anchor.is_empty() {
                    None
                } else {
                    let project = ctx
                        .project()
                        .ok_or_else(|| Error::Invalid("No project is open".into()))?;
                    let text = project.read_file(target)?;
                    heading_line(&text, &anchor).map(|line| {
                        let at = Position::new(line, 0);
                        Range::new(at.clone(), at)
                    })
                };
                host::open_editor(target, selection)?;
                if !anchor.is_empty() {
                    let target_path = normalize_path(&target_path);
                    self.anchors.insert(target_path.clone(), anchor.clone());
                    host::post_view_message(
                        VIEW,
                        &serde_json::json!({
                            "kind": "preview-anchor", "path": target_path, "anchor": anchor,
                        })
                        .to_string(),
                    )?;
                }
                Ok(())
            }
            Request::Url { .. } | Request::ReadZoom | Request::AdjustZoom { .. } => unreachable!(),
        }
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir if normalized.file_name().is_some() => {
                normalized.pop();
            }
            Component::CurDir => {}
            _ => normalized.push(component),
        }
    }
    normalized
}

fn preview_zoom(step: Option<i8>) -> Result<(), Error> {
    let dir = host::fs::plugin_dir()?;
    let name = "preview-font-size";
    let path = Path::new(&dir).join(name);
    let path = path
        .to_str()
        .ok_or_else(|| Error::Invalid("Invalid plugin data directory".into()))?;
    let stored = if host::fs::read_dir(&dir)?
        .iter()
        .any(|entry| entry.name == name)
    {
        host::fs::read_file(path)?
            .trim()
            .parse::<i8>()
            .ok()
            .filter(|value| (8..=40).contains(value))
    } else {
        None
    };
    let current = stored.unwrap_or(DEFAULT_PREVIEW_SIZE);
    let size = match step {
        None => current,
        Some(0) => DEFAULT_PREVIEW_SIZE,
        Some(delta) => (current + delta).clamp(8, 40),
    };
    if size != current {
        host::fs::write_file(path, &size.to_string())?;
    }
    host::post_view_message(
        VIEW,
        &serde_json::json!({ "kind": "preview-zoom", "size": size }).to_string(),
    )
}

fn heading_line(text: &str, anchor: &str) -> Option<u32> {
    let mut heading = None;
    let mut used = HashSet::new();
    for (event, range) in Parser::new(text).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { .. }) => heading = Some((range.start, String::new())),
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, label)) = &mut heading {
                    label.push_str(&text);
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                let (offset, label) = heading.take()?;
                let base: String = label
                    .to_lowercase()
                    .chars()
                    .filter_map(|ch| {
                        if ch.is_whitespace() {
                            Some('-')
                        } else {
                            (ch.is_alphanumeric() || ch == '-' || ch == '_').then_some(ch)
                        }
                    })
                    .collect();
                let mut slug = base.clone();
                for suffix in 1.. {
                    if used.insert(slug.clone()) {
                        break;
                    }
                    slug = format!("{base}-{suffix}");
                }
                if slug == anchor {
                    return Some(
                        text[..offset].bytes().filter(|&byte| byte == b'\n').count() as u32
                    );
                }
            }
            _ => {}
        }
    }
    None
}

register_plugin!(Navigation, views);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_formatted_and_duplicate_headings() {
        let doc = "# **Подход** к делу\n\nA title\n===\n\n# Подход к делу\n";
        assert_eq!(heading_line(doc, "подход-к-делу"), Some(0));
        assert_eq!(heading_line(doc, "a-title"), Some(2));
        assert_eq!(heading_line(doc, "подход-к-делу-1"), Some(5));
    }
}
