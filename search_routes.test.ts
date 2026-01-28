import * as express from 'express';
import * as request from 'supertest';

import * as util from '../utils/util';
import * as setupSearchRoutes from './search_routes';

jest.mock('express-mysql-session', () => () => jest.fn());

describe('search router', () => {
  const app = express();

  const ensureAuthenticatedAndCheckIDP = jest.fn();

  setupSearchRoutes(app, ensureAuthenticatedAndCheckIDP);

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('GET /searchtermsuggest', () => {
    it('should return search term suggestions for regular user', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      const mockRows = [
        { term: 'testing', totalCount: 10 },
        { term: 'test', totalCount: 8 },
        { term: 'testimony', totalCount: 5 },
      ];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockRows);

      await request(app)
        .get('/searchtermsuggest?termPrefix=test')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            suggestions: ['testing', 'test', 'testimony'],
          });
        });

      expect(util.runQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          vars: expect.objectContaining({
            userId: 1,
            idpId: 2,
          }),
        })
      );
    });

    it('should return search term suggestions for admin user', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: true };
        return next();
      });

      const mockRows = [{ term: 'admin', totalCount: 15 }];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockRows);

      await request(app)
        .get('/searchtermsuggest?termPrefix=adm')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            suggestions: ['admin'],
          });
        });
    });

    it('should return suggestions for specific book', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      const mockRows = [{ term: 'chapter', totalCount: 20 }];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockRows);

      await request(app)
        .get('/searchtermsuggest/123?termPrefix=chap')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            suggestions: ['chapter'],
          });
        });

      expect(util.runQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          vars: expect.objectContaining({
            bookId: '123',
            userId: 1,
            idpId: 2,
          }),
        })
      );
    });

    it('should handle empty results', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue([]);

      await request(app)
        .get('/searchtermsuggest?termPrefix=xyz')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            suggestions: [],
          });
        });
    });
  });

  describe('GET /search', () => {
    it('should return search results for regular user', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      const mockResults = [
        { id: 1, text: 'This is a test result', book_id: 5 },
        { id: 2, text: 'Another test result', book_id: 5 },
      ];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockResults);
      (util as any).dedup = jest.fn((arr) => arr);
      (util as any).convertJsonColsFromStrings = jest.fn();

      await request(app)
        .get('/search?searchStr=test&limit=50&offset=0')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            results: mockResults,
          });
        });

      expect(util.runQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          vars: expect.objectContaining({
            userId: 1,
            idpId: 2,
          }),
        })
      );

      expect(util.convertJsonColsFromStrings).toHaveBeenCalledWith({
        tableName: 'book_textnode_index',
        rows: mockResults,
      });
    });

    it('should return search results for admin user', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: true };
        return next();
      });

      const mockResults = [{ id: 1, text: 'Admin search result', book_id: 10 }];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockResults);
      (util as any).dedup = jest.fn((arr) => arr);
      (util as any).convertJsonColsFromStrings = jest.fn();

      await request(app)
        .get('/search?searchStr=admin')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            results: mockResults,
          });
        });
    });

    it('should enforce limit max of 100', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      const mockResults = [];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockResults);
      (util as any).dedup = jest.fn((arr) => arr);
      (util as any).convertJsonColsFromStrings = jest.fn();

      await request(app)
        .get('/search?searchStr=test&limit=500')
        .expect(200);

      // Check that the query was called with limit 100 in the SQL
      const queryCall = (util.runQuery as jest.Mock).mock.calls[0][0];
      expect(queryCall.query).toContain('LIMIT 100');
    });

    it('should use default limit of 100 when not provided', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      const mockResults = [];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockResults);
      (util as any).dedup = jest.fn((arr) => arr);
      (util as any).convertJsonColsFromStrings = jest.fn();

      await request(app).get('/search?searchStr=test').expect(200);

      const queryCall = (util.runQuery as jest.Mock).mock.calls[0][0];
      expect(queryCall.query).toContain('LIMIT 100');
    });

    it('should handle offset parameter', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      const mockResults = [];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue(mockResults);
      (util as any).dedup = jest.fn((arr) => arr);
      (util as any).convertJsonColsFromStrings = jest.fn();

      await request(app)
        .get('/search?searchStr=test&offset=25')
        .expect(200);

      const queryCall = (util.runQuery as jest.Mock).mock.calls[0][0];
      expect(queryCall.query).toContain('OFFSET 25');
    });

    it('should return 403 when user lacks access to specific book', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).hasAccess = jest.fn().mockResolvedValue(null);

      await request(app)
        .get('/search/123?searchStr=test')
        .expect(403)
        .expect('Content-Type', /json/)
        .expect('{"error":"Forbidden"}');

      expect(util.hasAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: '123',
        })
      );
    });

    it('should search specific book when user has access', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      const mockResults = [
        { id: 1, text: 'Book specific result', book_id: 123 },
      ];

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).hasAccess = jest.fn().mockResolvedValue(true);
      (util as any).runQuery = jest.fn().mockResolvedValue(mockResults);
      (util as any).dedup = jest.fn((arr) => arr);
      (util as any).convertJsonColsFromStrings = jest.fn();

      await request(app)
        .get('/search/123?searchStr=test')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            results: mockResults,
          });
        });

      expect(util.hasAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: '123',
        })
      );

      expect(util.runQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          vars: expect.objectContaining({
            bookId: '123',
            userId: 1,
            idpId: 2,
          }),
        })
      );
    });

    it('should handle empty search results', async () => {
      ensureAuthenticatedAndCheckIDP.mockImplementation((req, res, next) => {
        req.user = { id: 1, idpId: 2, isAdmin: false };
        return next();
      });

      (util as any).timestampToMySQLDatetime = jest
        .fn()
        .mockReturnValue('2024-01-01 00:00:00');
      (util as any).runQuery = jest.fn().mockResolvedValue([]);
      (util as any).dedup = jest.fn((arr) => arr);
      (util as any).convertJsonColsFromStrings = jest.fn();

      await request(app)
        .get('/search?searchStr=nonexistent')
        .expect(200)
        .expect('Content-Type', /json/)
        .then((response) => {
          expect(response.body).toEqual({
            success: true,
            results: [],
          });
        });
    });
  });
});