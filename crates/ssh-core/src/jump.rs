//! ProxyJump chain resolution and cycle detection.
//!
//! Pure graph logic lives here (unit-tested without network). Actual multi-hop
//! TCP/SSH is implemented in [`crate::session`].

use std::collections::HashSet;

use protocol::Connection;
use uuid::Uuid;

use crate::error::CoreError;

/// Resolve `target` → jump parents into a connect order: `[outermost_jump, …, target]`.
///
/// `lookup(id)` returns the connection or `None` if missing.
pub fn resolve_jump_chain<F>(target: &Connection, mut lookup: F) -> Result<Vec<Connection>, CoreError>
where
    F: FnMut(Uuid) -> Option<Connection>,
{
    let mut chain_rev = vec![target.clone()];
    let mut seen = HashSet::new();
    seen.insert(target.id);

    let mut current_jump = target.jump_host;
    while let Some(jump_id) = current_jump {
        if !seen.insert(jump_id) {
            return Err(CoreError::Other(format!(
                "ProxyJump cycle detected at connection {jump_id}"
            )));
        }
        let jump = lookup(jump_id).ok_or_else(|| {
            CoreError::Other(format!("ProxyJump target not found: {jump_id}"))
        })?;
        current_jump = jump.jump_host;
        chain_rev.push(jump);
    }

    chain_rev.reverse();
    Ok(chain_rev)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{AuthMethod, ConnectionSource};
    use std::collections::HashMap;

    fn conn(id: Uuid, jump: Option<Uuid>) -> Connection {
        Connection {
            id,
            name: id.to_string(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth: AuthMethod::Agent,
            group: None,
            tags: vec![],
            jump_host: jump,
            tunnels: vec![],
            protocol: Default::default(),
            source: ConnectionSource::Manual,
            last_connected: None,
            notes: None,
            serial_config: None,
        }
    }

    #[test]
    fn no_jump_is_single() {
        let a = Uuid::from_u128(1);
        let c = conn(a, None);
        let chain = resolve_jump_chain(&c, |_| None).unwrap();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].id, a);
    }

    #[test]
    fn single_jump_order() {
        let bastion = Uuid::from_u128(1);
        let target = Uuid::from_u128(2);
        let map: HashMap<Uuid, Connection> = [
            (bastion, conn(bastion, None)),
            (target, conn(target, Some(bastion))),
        ]
        .into_iter()
        .collect();
        let chain = resolve_jump_chain(&map[&target], |id| map.get(&id).cloned()).unwrap();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].id, bastion);
        assert_eq!(chain[1].id, target);
    }

    #[test]
    fn two_jumps_order() {
        let j1 = Uuid::from_u128(1);
        let j2 = Uuid::from_u128(2);
        let t = Uuid::from_u128(3);
        let map: HashMap<Uuid, Connection> = [
            (j1, conn(j1, None)),
            (j2, conn(j2, Some(j1))),
            (t, conn(t, Some(j2))),
        ]
        .into_iter()
        .collect();
        let chain = resolve_jump_chain(&map[&t], |id| map.get(&id).cloned()).unwrap();
        assert_eq!(
            chain.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![j1, j2, t]
        );
    }

    #[test]
    fn cycle_errors() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let map: HashMap<Uuid, Connection> = [
            (a, conn(a, Some(b))),
            (b, conn(b, Some(a))),
        ]
        .into_iter()
        .collect();
        let err = resolve_jump_chain(&map[&a], |id| map.get(&id).cloned()).unwrap_err();
        assert!(err.to_string().contains("cycle"), "{err}");
    }

    #[test]
    fn missing_jump_errors() {
        let t = Uuid::from_u128(9);
        let c = conn(t, Some(Uuid::from_u128(99)));
        let err = resolve_jump_chain(&c, |_| None).unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
    }
}
