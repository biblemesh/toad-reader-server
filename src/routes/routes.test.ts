import express from 'express';
import passport from 'passport';
import request from 'supertest';

import util from '../utils/util';
import setupRoutes from './routes';

// Prevent further routers from being loaded
global.requireRouter = jest.fn().mockReturnValue(jest.fn());

jest.mock('express-mysql-session', () => () => jest.fn());

describe('base router', () => {
  const app = express();

  const s3 = {
    getObject: (params, callback) => callback(null, { Body: 'foo bar baz' }),
  };
  const authFuncs = jest.fn();
  const ensureAuthenticated = jest.fn();
  const logIn = jest.fn();

  setupRoutes(app, s3, passport, authFuncs, ensureAuthenticated, logIn);

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('GET /: forbidden', async () => {
    ensureAuthenticated.mockImplementation((req, res, next) => next());
    await request(app)
      .get('/')
      .expect(403)
      .expect('Content-Type', /json/)
      .expect('{"error":"Forbidden"}');
  });

  it('GET /epub_content/some_book.epub', async () => {
    ensureAuthenticated.mockImplementation((req, res, next) => {
      req.hasInitialCookiePathForEmbed = true;
      return next();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (util as any).hasAccess = jest.fn().mockReturnValue(true);
    await request(app)
      .get('/epub_content/some_book.epub')
      .expect(200)
      .expect('Content-Type', /epub/)
      .expect('foo bar baz');
  });

  it.each([['/src/js/widget_setup.js', '/scripts/widget_setup.js']])(
    'GET %s',
    async (url) => {
      await request(app)
        .get(url)
        .expect(200)
        .expect('Content-Type', /javascript/);
    },
  );
});
