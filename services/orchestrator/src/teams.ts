// Teams (#177) — account-level sharing.
//
// A per-server invitation (#176) says "this person, this server". A team says
// "these people, all of these servers", which is what stops sharing becoming
// clerical work once there is more than one of either.
//
// A server is still owned by an individual and merely *shared* to a team, so
// ownership is never ambiguous and deleting a team can never delete a server.

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { isGrantableRole } from './access.js';
import { principalOf } from './auth.js';
import {
  accessOf,
  requirePermission,
  requireTeamPermission,
  requireTeamPermissionOrSelf,
  teamAccessFor,
  teamAccessOf,
  teamGuard,
} from './accessGuard.js';
import type { Repository } from './types.js';

export function createTeamRouter(deps: { repo: Repository }): Router {
  const { repo } = deps;
  const router = Router();

  router.get('/teams', async (req: Request, res: Response) => {
    res.json(await repo.listTeamsForUser(principalOf(req).id));
  });

  router.post('/teams', async (req: Request, res: Response) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'a team name is required' });
    const team = await repo.createTeam({ id: randomUUID(), name, ownerId: principalOf(req).id });
    return res.status(201).json(team);
  });

  // Everything addressing one team is behind the guard, so a route added below
  // is authorized by default and only has to declare which permission it needs.
  // A team the caller does not belong to reads as 404, never 403.
  router.use('/teams/:id', teamGuard(repo));

  router.get('/teams/:id', requireTeamPermission('team.view'), async (req: Request, res: Response) => {
    const { team } = teamAccessOf(req);
    res.json({ ...team, members: await repo.listTeamMembers(team.id) });
  });

  router.delete(
    '/teams/:id',
    requireTeamPermission('team.delete', 'only the team owner can delete it'),
    async (req: Request, res: Response) => {
      // Servers are detached, never deleted — see the repository.
      await repo.deleteTeam(teamAccessOf(req).team.id);
      res.status(204).end();
    },
  );

  router.post(
    '/teams/:id/members',
    requireTeamPermission('team.members.manage', 'only the team owner can add members'),
    async (req: Request, res: Response) => {
      const { team } = teamAccessOf(req);
      const { email, role } = req.body ?? {};
      if (!isGrantableRole(role)) return res.status(400).json({ error: 'role must be admin, operator or viewer' });

      // Unlike a server invitation, membership needs an existing account: a team
      // grants access to every server the team holds, present and future, so it
      // should not sit waiting on an address nobody has claimed.
      const user = typeof email === 'string' ? await repo.getUserByEmail(email.trim().toLowerCase()) : null;
      if (!user) return res.status(404).json({ error: 'no account with that email — ask them to sign up first' });
      if (user.id === team.ownerId) return res.status(400).json({ error: 'the team owner is already a member' });

      return res.status(201).json(await repo.addTeamMember({ teamId: team.id, userId: user.id, role }));
    },
  );

  router.patch(
    '/teams/:id/members/:userId',
    requireTeamPermission('team.members.manage', 'only the team owner can change roles'),
    async (req: Request, res: Response) => {
      const { team } = teamAccessOf(req);
      if (!isGrantableRole(req.body?.role)) return res.status(400).json({ error: 'role must be admin, operator or viewer' });
      if (!(await repo.getTeamMember(team.id, req.params.userId))) return res.status(404).json({ error: 'member not found' });
      return res.json(await repo.addTeamMember({ teamId: team.id, userId: req.params.userId, role: req.body.role }));
    },
  );

  router.delete(
    '/teams/:id/members/:userId',
    // The owner removes anyone; anyone else may remove only themselves (leave).
    requireTeamPermissionOrSelf(
      'team.members.manage',
      (req) => req.params.userId,
      'only the team owner can remove other members',
    ),
    async (req: Request, res: Response) => {
      await repo.removeTeamMember(teamAccessOf(req).team.id, req.params.userId);
      res.status(204).end();
    },
  );

  return router;
}

/**
 * Attach or detach a server's team. Mounted under the server access guard, and
 * gated on `server.delete` — the strongest permission — because sharing a server
 * with a group is an ownership decision, not day-to-day management.
 */
export function createServerTeamRouter(deps: { repo: Repository }): Router {
  const { repo } = deps;
  const router = Router();

  router.patch('/deployments/:id/team', requirePermission('server.delete'), async (req: Request, res: Response) => {
    const { deployment } = accessOf(req);
    const teamId = req.body?.teamId ?? null;

    if (teamId !== null) {
      if (typeof teamId !== 'string') return res.status(400).json({ error: 'teamId must be a team id or null' });
      // You can only share into a team you are in — otherwise a server could be
      // pushed onto strangers. Same resolution as the guard, since the team is
      // named in the body here rather than the path.
      if (!(await teamAccessFor(repo, teamId, principalOf(req).id))) {
        return res.status(404).json({ error: 'team not found' });
      }
    }

    const config = await repo.getDeploymentConfig(deployment.id);
    if (!config) return res.status(404).json({ error: 'server config not found' });
    await repo.setServerTeam(config.id, teamId);
    return res.json({ deploymentId: deployment.id, teamId });
  });

  return router;
}
