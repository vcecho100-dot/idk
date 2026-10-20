//! The library index (SQLite via rusqlite). Typed commands are the only way in —
//! the webview can never run SQL.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult, ErrorCode};

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        match err {
            rusqlite::Error::QueryReturnedNoRows => AppError::new(ErrorCode::NotFound, "That item no longer exists."),
            other => AppError::internal(format!("Library database error: {other}")),
        }
    }
}

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        prompt TEXT NOT NULL DEFAULT '',
        style TEXT,
        provider TEXT,
        current_version_id TEXT,
        thumbnail_version_id TEXT
    );
    CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provider TEXT,
        params TEXT NOT NULL DEFAULT '{}',
        stats TEXT,
        file_size INTEGER NOT NULL DEFAULT 0,
        has_thumbnail INTEGER NOT NULL DEFAULT 0,
        variant_group TEXT,
        variant_index INTEGER
    );
    CREATE INDEX IF NOT EXISTS versions_by_project ON versions(project_id, created_at);
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        stage TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        variant_group TEXT,
        variant_index INTEGER,
        parent_version_id TEXT,
        result_version_id TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        spec TEXT NOT NULL,
        remote TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS usage (
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        succeeded INTEGER NOT NULL,
        credits REAL NOT NULL DEFAULT 0,
        at TEXT NOT NULL
    );
    "#,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStats {
    pub triangles: u64,
    pub vertices: u64,
    pub materials: u64,
    pub textures: u64,
    pub max_texture_size: u64,
    pub file_size: u64,
    pub animations: Vec<String>,
    pub has_skin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub prompt: String,
    pub style: Option<String>,
    pub provider: Option<String>,
    pub current_version_id: Option<String>,
    pub thumbnail_version_id: Option<String>,
    pub version_count: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub label: String,
    pub created_at: String,
    pub provider: Option<String>,
    pub params: Value,
    pub stats: Option<ModelStats>,
    pub file_size: u64,
    pub has_thumbnail: bool,
    pub variant_group: Option<String>,
    pub variant_index: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub code: crate::error::ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hint: Option<String>,
}

impl From<&AppError> for JobError {
    fn from(e: &AppError) -> Self {
        Self { code: e.code, message: e.message.clone(), hint: e.hint.clone() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub provider: String,
    pub status: String,
    pub progress: f64,
    pub stage: String,
    pub title: String,
    pub variant_group: Option<String>,
    pub variant_index: Option<i64>,
    pub parent_version_id: Option<String>,
    pub result_version_id: Option<String>,
    pub error: Option<JobError>,
    pub attempts: i64,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// A job row plus the engine-only fields (request spec and remote handle).
#[derive(Debug, Clone)]
pub struct JobRecord {
    pub job: Job,
    pub spec: Value,
    pub remote: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub provider: String,
    pub jobs: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub credits_spent: f64,
    pub last_used_at: Option<String>,
}

pub struct Db {
    conn: Mutex<Connection>,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn json_or<T: serde::de::DeserializeOwned>(raw: Option<String>, fallback: T) -> T {
    raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(fallback)
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> AppResult<T> {
        let conn = self.conn.lock().map_err(|_| AppError::internal("Library database is unavailable."))?;
        Ok(f(&conn)?)
    }

    /* ------------------------------- Projects ------------------------------- */

    const PROJECT_SELECT: &'static str = "SELECT p.id, p.name, p.created_at, p.updated_at, p.favorite, p.tags, p.prompt, p.style, p.provider,
            p.current_version_id, p.thumbnail_version_id,
            (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id),
            (SELECT COALESCE(SUM(v.file_size), 0) FROM versions v WHERE v.project_id = p.id)
         FROM projects p";

    fn project_row(r: &Row) -> rusqlite::Result<Project> {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
            created_at: r.get(2)?,
            updated_at: r.get(3)?,
            favorite: r.get::<_, i64>(4)? != 0,
            tags: json_or(r.get(5)?, vec![]),
            prompt: r.get(6)?,
            style: r.get(7)?,
            provider: r.get(8)?,
            current_version_id: r.get(9)?,
            thumbnail_version_id: r.get(10)?,
            version_count: r.get::<_, i64>(11)? as u64,
            size_bytes: r.get::<_, i64>(12)? as u64,
        })
    }

    pub fn insert_project(&self, p: &Project) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO projects (id, name, created_at, updated_at, favorite, tags, prompt, style, provider, current_version_id, thumbnail_version_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    p.id,
                    p.name,
                    p.created_at,
                    p.updated_at,
                    p.favorite as i64,
                    serde_json::to_string(&p.tags).unwrap_or_else(|_| "[]".into()),
                    p.prompt,
                    p.style,
                    p.provider,
                    p.current_version_id,
                    p.thumbnail_version_id
                ],
            )
            .map(|_| ())
        })
    }

    pub fn project(&self, id: &str) -> AppResult<Project> {
        self.with(|c| c.query_row(&format!("{} WHERE p.id = ?1", Self::PROJECT_SELECT), [id], Self::project_row))
    }

    pub fn projects(&self) -> AppResult<Vec<Project>> {
        self.with(|c| {
            let mut stmt = c.prepare(&format!(
                "{} WHERE EXISTS (SELECT 1 FROM versions v WHERE v.project_id = p.id)
                    OR EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = p.id)
                 ORDER BY p.updated_at DESC",
                Self::PROJECT_SELECT
            ))?;
            let rows = stmt.query_map([], Self::project_row)?;
            rows.collect()
        })
    }

    pub fn update_project(&self, p: &Project) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "UPDATE projects SET name=?2, updated_at=?3, favorite=?4, tags=?5, prompt=?6, style=?7, provider=?8,
                    current_version_id=?9, thumbnail_version_id=?10 WHERE id=?1",
                params![
                    p.id,
                    p.name,
                    p.updated_at,
                    p.favorite as i64,
                    serde_json::to_string(&p.tags).unwrap_or_else(|_| "[]".into()),
                    p.prompt,
                    p.style,
                    p.provider,
                    p.current_version_id,
                    p.thumbnail_version_id
                ],
            )
            .map(|_| ())
        })
    }

    pub fn delete_project(&self, id: &str) -> AppResult<()> {
        self.with(|c| {
            c.execute("DELETE FROM versions WHERE project_id = ?1", [id])?;
            c.execute("DELETE FROM jobs WHERE project_id = ?1", [id])?;
            c.execute("DELETE FROM projects WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /* ------------------------------- Versions ------------------------------- */

    fn version_row(r: &Row) -> rusqlite::Result<Version> {
        Ok(Version {
            id: r.get(0)?,
            project_id: r.get(1)?,
            parent_id: r.get(2)?,
            kind: r.get(3)?,
            label: r.get(4)?,
            created_at: r.get(5)?,
            provider: r.get(6)?,
            params: json_or(r.get(7)?, Value::Object(Default::default())),
            stats: r.get::<_, Option<String>>(8)?.and_then(|s| serde_json::from_str(&s).ok()),
            file_size: r.get::<_, i64>(9)? as u64,
            has_thumbnail: r.get::<_, i64>(10)? != 0,
            variant_group: r.get(11)?,
            variant_index: r.get(12)?,
        })
    }

    const VERSION_SELECT: &'static str = "SELECT id, project_id, parent_id, kind, label, created_at, provider, params, stats, file_size,
            has_thumbnail, variant_group, variant_index FROM versions";

    pub fn insert_version(&self, v: &Version) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO versions (id, project_id, parent_id, kind, label, created_at, provider, params, stats, file_size, has_thumbnail, variant_group, variant_index)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    v.id,
                    v.project_id,
                    v.parent_id,
                    v.kind,
                    v.label,
                    v.created_at,
                    v.provider,
                    v.params.to_string(),
                    v.stats.as_ref().and_then(|s| serde_json::to_string(s).ok()),
                    v.file_size as i64,
                    v.has_thumbnail as i64,
                    v.variant_group,
                    v.variant_index
                ],
            )
            .map(|_| ())
        })
    }

    pub fn version(&self, id: &str) -> AppResult<Version> {
        self.with(|c| c.query_row(&format!("{} WHERE id = ?1", Self::VERSION_SELECT), [id], Self::version_row))
    }

    pub fn versions(&self, project_id: &str) -> AppResult<Vec<Version>> {
        self.with(|c| {
            let mut stmt = c.prepare(&format!("{} WHERE project_id = ?1 ORDER BY created_at ASC", Self::VERSION_SELECT))?;
            let rows = stmt.query_map([project_id], Self::version_row)?;
            rows.collect()
        })
    }

    pub fn set_version_thumbnail(&self, id: &str, has: bool) -> AppResult<()> {
        self.with(|c| c.execute("UPDATE versions SET has_thumbnail = ?2 WHERE id = ?1", params![id, has as i64]).map(|_| ()))
    }

    pub fn reparent_children(&self, version_id: &str, new_parent: Option<&str>) -> AppResult<()> {
        self.with(|c| c.execute("UPDATE versions SET parent_id = ?2 WHERE parent_id = ?1", params![version_id, new_parent]).map(|_| ()))
    }

    pub fn delete_version(&self, id: &str) -> AppResult<()> {
        self.with(|c| c.execute("DELETE FROM versions WHERE id = ?1", [id]).map(|_| ()))
    }

    /* --------------------------------- Jobs --------------------------------- */

    fn job_row(r: &Row) -> rusqlite::Result<JobRecord> {
        Ok(JobRecord {
            job: Job {
                id: r.get(0)?,
                project_id: r.get(1)?,
                kind: r.get(2)?,
                provider: r.get(3)?,
                status: r.get(4)?,
                progress: r.get(5)?,
                stage: r.get(6)?,
                title: r.get(7)?,
                variant_group: r.get(8)?,
                variant_index: r.get(9)?,
                parent_version_id: r.get(10)?,
                result_version_id: r.get(11)?,
                error: r.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
                attempts: r.get(13)?,
                created_at: r.get(14)?,
                updated_at: r.get(15)?,
                started_at: r.get(16)?,
                finished_at: r.get(17)?,
            },
            spec: json_or(r.get(18)?, Value::Null),
            remote: r.get::<_, Option<String>>(19)?.and_then(|s| serde_json::from_str(&s).ok()),
        })
    }

    const JOB_SELECT: &'static str = "SELECT id, project_id, kind, provider, status, progress, stage, title, variant_group, variant_index,
            parent_version_id, result_version_id, error, attempts, created_at, updated_at, started_at, finished_at, spec, remote FROM jobs";

    pub fn upsert_job(&self, rec: &JobRecord) -> AppResult<()> {
        let j = &rec.job;
        self.with(|c| {
            c.execute(
                "INSERT INTO jobs (id, project_id, kind, provider, status, progress, stage, title, variant_group, variant_index,
                    parent_version_id, result_version_id, error, attempts, created_at, updated_at, started_at, finished_at, spec, remote)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
                 ON CONFLICT(id) DO UPDATE SET status=excluded.status, progress=excluded.progress, stage=excluded.stage,
                    result_version_id=excluded.result_version_id, error=excluded.error, attempts=excluded.attempts,
                    updated_at=excluded.updated_at, started_at=excluded.started_at, finished_at=excluded.finished_at,
                    spec=excluded.spec, remote=excluded.remote, provider=excluded.provider",
                params![
                    j.id,
                    j.project_id,
                    j.kind,
                    j.provider,
                    j.status,
                    j.progress,
                    j.stage,
                    j.title,
                    j.variant_group,
                    j.variant_index,
                    j.parent_version_id,
                    j.result_version_id,
                    j.error.as_ref().and_then(|e| serde_json::to_string(e).ok()),
                    j.attempts,
                    j.created_at,
                    j.updated_at,
                    j.started_at,
                    j.finished_at,
                    rec.spec.to_string(),
                    rec.remote.as_ref().map(|r| r.to_string())
                ],
            )
            .map(|_| ())
        })
    }

    pub fn job(&self, id: &str) -> AppResult<JobRecord> {
        self.with(|c| c.query_row(&format!("{} WHERE id = ?1", Self::JOB_SELECT), [id], Self::job_row))
    }

    pub fn job_opt(&self, id: &str) -> AppResult<Option<JobRecord>> {
        self.with(|c| c.query_row(&format!("{} WHERE id = ?1", Self::JOB_SELECT), [id], Self::job_row).optional())
    }

    pub fn jobs(&self) -> AppResult<Vec<JobRecord>> {
        self.with(|c| {
            let mut stmt = c.prepare(&format!("{} ORDER BY created_at DESC LIMIT 200", Self::JOB_SELECT))?;
            let rows = stmt.query_map([], Self::job_row)?;
            rows.collect()
        })
    }

    pub fn jobs_with_status(&self, statuses: &[&str]) -> AppResult<Vec<JobRecord>> {
        let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        self.with(|c| {
            let mut stmt = c.prepare(&format!("{} WHERE status IN ({placeholders}) ORDER BY created_at ASC", Self::JOB_SELECT))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(statuses.iter()), Self::job_row)?;
            rows.collect()
        })
    }

    pub fn delete_job(&self, id: &str) -> AppResult<()> {
        self.with(|c| c.execute("DELETE FROM jobs WHERE id = ?1", [id]).map(|_| ()))
    }

    pub fn delete_finished_jobs(&self) -> AppResult<()> {
        self.with(|c| c.execute("DELETE FROM jobs WHERE status IN ('succeeded','failed','canceled')", []).map(|_| ()))
    }

    /* --------------------------------- Usage -------------------------------- */

    pub fn record_usage(&self, provider: &str, kind: &str, succeeded: bool, credits: f64) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO usage (provider, kind, succeeded, credits, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![provider, kind, succeeded as i64, credits, now()],
            )
            .map(|_| ())
        })
    }

    pub fn usage(&self) -> AppResult<Vec<ProviderUsage>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT provider, COUNT(*), SUM(succeeded), SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END), COALESCE(SUM(credits), 0), MAX(at)
                 FROM usage GROUP BY provider",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(ProviderUsage {
                    provider: r.get(0)?,
                    jobs: r.get::<_, i64>(1)? as u64,
                    succeeded: r.get::<_, i64>(2)? as u64,
                    failed: r.get::<_, i64>(3)? as u64,
                    credits_spent: r.get(4)?,
                    last_used_at: r.get(5)?,
                })
            })?;
            rows.collect()
        })
    }

    /// Average credits a provider charged for a job kind (calibrates cost estimates).
    pub fn average_credits(&self, provider: &str, kind: &str) -> AppResult<Option<f64>> {
        self.with(|c| {
            c.query_row(
                "SELECT AVG(credits) FROM usage WHERE provider = ?1 AND kind = ?2 AND succeeded = 1 AND credits > 0",
                params![provider, kind],
                |r| r.get::<_, Option<f64>>(0),
            )
        })
    }

    pub fn reset(&self) -> AppResult<()> {
        self.with(|c| c.execute_batch("DELETE FROM versions; DELETE FROM jobs; DELETE FROM projects; DELETE FROM usage;"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: "Robot".into(),
            created_at: now(),
            updated_at: now(),
            favorite: false,
            tags: vec!["sci-fi".into()],
            prompt: "a robot".into(),
            style: Some("stylized".into()),
            provider: Some("mock".into()),
            current_version_id: None,
            thumbnail_version_id: None,
            version_count: 0,
            size_bytes: 0,
        }
    }

    fn version(id: &str, project: &str, size: u64) -> Version {
        Version {
            id: id.into(),
            project_id: project.into(),
            parent_id: None,
            kind: "generate".into(),
            label: "Generated".into(),
            created_at: now(),
            provider: Some("mock".into()),
            params: serde_json::json!({ "sampleId": "robot" }),
            stats: None,
            file_size: size,
            has_thumbnail: false,
            variant_group: None,
            variant_index: None,
        }
    }

    #[test]
    fn project_roundtrip_with_aggregates() {
        let db = Db::open_in_memory().unwrap();
        db.insert_project(&project("p1")).unwrap();
        db.insert_version(&version("v1", "p1", 100)).unwrap();
        db.insert_version(&version("v2", "p1", 50)).unwrap();
        let p = db.project("p1").unwrap();
        assert_eq!(p.version_count, 2);
        assert_eq!(p.size_bytes, 150);
        assert_eq!(p.tags, vec!["sci-fi".to_string()]);
        assert_eq!(db.projects().unwrap().len(), 1);
        assert_eq!(db.versions("p1").unwrap()[0].params["sampleId"], "robot");
    }

    #[test]
    fn empty_projects_are_hidden() {
        let db = Db::open_in_memory().unwrap();
        db.insert_project(&project("p1")).unwrap();
        assert!(db.projects().unwrap().is_empty());
    }

    #[test]
    fn delete_cascades() {
        let db = Db::open_in_memory().unwrap();
        db.insert_project(&project("p1")).unwrap();
        db.insert_version(&version("v1", "p1", 1)).unwrap();
        db.delete_project("p1").unwrap();
        assert!(db.version("v1").is_err());
        assert!(db.project("p1").is_err());
    }

    #[test]
    fn usage_aggregates() {
        let db = Db::open_in_memory().unwrap();
        db.record_usage("tripo", "generate", true, 30.0).unwrap();
        db.record_usage("tripo", "generate", true, 40.0).unwrap();
        db.record_usage("tripo", "generate", false, 0.0).unwrap();
        let u = db.usage().unwrap();
        assert_eq!(u[0].jobs, 3);
        assert_eq!(u[0].succeeded, 2);
        assert_eq!(u[0].failed, 1);
        assert_eq!(db.average_credits("tripo", "generate").unwrap(), Some(35.0));
    }
}
