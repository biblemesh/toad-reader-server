const fs = require('fs')
const multiparty = require('multiparty')
const admzip = require('adm-zip')
const Jimp = require("jimp")
const fetch = require('node-fetch')
const mime = require('mime')
const uuidv4 = require('uuid/v4')
const mm = require('music-metadata')

const util = require('../utils/util')
const parseEpub = require('../utils/parseEpub')
const { getIndexedBook } = require('../utils/indexEpub')

const MAX_AUDIOBOOK_FILE_MEBIBYTE = 50  // over an hour, on average
const MAX_AUDIOBOOK_MEBIBYTE = 750

// to avoid a memory error, taken from here: https://github.com/jimp-dev/jimp/issues/915
const cachedJpegDecoder = Jimp.decoders['image/jpeg']
Jimp.decoders['image/jpeg'] = data => {
  const userOpts = { maxMemoryUsageInMB: 2048 }
  return cachedJpegDecoder(data, userOpts)
}

let baseTmpDir = process.env.IS_DEV ? `` : '/tmp'
if(baseTmpDir) {
  if(!fs.existsSync(baseTmpDir)) fs.mkdirSync(baseTmpDir)
  baseTmpDir = `${baseTmpDir}/`
}

module.exports = function (app, s3, ensureAuthenticatedAndCheckIDP, log) {

  const deleteFolderRecursive = path => {
    log(['Delete folder', path], 2)
    if(fs.existsSync(path)) {
      fs.readdirSync(path).forEach(file => {
        const curPath = `${path}/${file}`
        if(fs.lstatSync(curPath).isDirectory()) { // recurse
          deleteFolderRecursive(curPath)
        } else { // delete file
          fs.unlinkSync(curPath)
        }
      })
      fs.rmdirSync(path)
    }
  }

  const emptyS3Folder = async Prefix => {
    log(['Empty S3 folder', Prefix], 2)
    const data = await s3.listObjects({
      Bucket: process.env.S3_BUCKET,
      Prefix,
    }).promise()

    if(data.Contents.length == 0) return

    const delParams = {
      Bucket: process.env.S3_BUCKET,
      Delete: {
        Objects: [],
      },
    }

    const overfull = data.Contents.length >= 1000
    data.Contents.slice(0,999).forEach(content => {
      delParams.Delete.Objects.push({ Key: content.Key })
    })

    if(delParams.Delete.Objects.length > 0) {
      await s3.deleteObjects(delParams).promise()
      if(overfull) {
        await emptyS3Folder(Prefix)
      }
    }
  }

  const deleteBook = async (bookId, next) => {
    log(['Delete book', bookId], 2)
    await util.runQuery({
      query: 'DELETE FROM `book` WHERE id=:bookId',
      vars: {
        bookId,
      },
      next,
    })

    await deleteBookSearchIndexRows(bookId, next)

    await emptyS3Folder(`epub_content/book_${bookId}/`)
  }

  const deleteBookIfUnassociated = async (bookId, next) => {
    // clear out book and its user data, if book unassociated

    log(['Check if book is unassociated', bookId]);
    const rows = await util.runQuery({
      query: 'SELECT * FROM `book-idp` WHERE book_id=:bookId LIMIT 1',
      vars: {
        bookId,
      },
      next,
    })

    if(rows.length > 0) return

    log(['Check if book is unused', bookId])
    const results = await util.runQuery({
      queries: [
        'SELECT id FROM book_instance WHERE book_id=:bookId LIMIT 1',
        'SELECT subscription_id FROM \`subscription-book\` WHERE book_id=:bookId LIMIT 1',
      ],
      vars: {
        bookId,
      },
      next,
    })

    if(results.some(rows2 => rows2.length > 0)) return

    await deleteBook(bookId, next)
  }

  const deleteBookSearchIndexRows = async (bookId, next) => {
    log(['Delete book search index rows', bookId], 2)
    await util.runQuery({
      queries: [
        'DELETE FROM `book_textnode_index` WHERE book_id=:bookId',
        'DELETE FROM `book_textnode_index_term` WHERE book_id=:bookId',
      ],
      vars: {
        bookId,
      },
      next,
    })
  }

  const getImageFileType = fileNameOrPath => {
    const mimeType = mime.getType(fileNameOrPath)
    const fileType = /jpeg/.test(mimeType) ? `jpeg` : (/webp/.test(mimeType) ? `webp` : `png`)
    return fileType
  }

  const getAdjustedImageBody = async (path, fileType, width, height) => {
    const img = await Jimp.read(path)
    img.resize(width || Jimp.AUTO, height || Jimp.AUTO)
    const result = await img.getBufferAsync(
      fileType === `jpeg`
        ? Jimp.MIME_JPEG
        : Jimp.MIME_PNG
    )
    return result
  }

  // delete a book
  app.delete(['/', '/book/:bookId'], ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to delete book', 3);
      res.status(403).send({ errorType: "no_permission" });
      return;
    }

    await util.runQuery({
      query: 'DELETE FROM `book-idp` WHERE book_id=:bookId AND idp_id=:idpId',
      vars: {
        bookId: req.params.bookId,
        idpId: req.user.idpId,
      },
      next,
    })

    log('Delete (idp disassociation) successful', 2)

    await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: req.params.bookId, log })

    res.send({ success: true });
          
  })

  // import book
  app.post('/importbook.json', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    const tmpDir = `${baseTmpDir}tmp_epub_${util.getUTCTimeStamp()}`
    const toUploadDir = `${tmpDir}/toupload`
    const epubFilePaths = []
    let bookRow, cleanUpBookIdpToDelete, beganResponse
    const { replaceExisting } = req.query

    deleteFolderRecursive(tmpDir)

    fs.mkdirSync(tmpDir)

    const form = new multiparty.Form({
      uploadDir: tmpDir
    })

    let processedOneFile = false  // at this point, we only allow one upload at a time

    form.on('file', async (name, file) => {

      if(processedOneFile) return
      processedOneFile = true

      try {

        if(
          req.tenantAuthInfo
          && (req.tenantAuthInfo || {}).action !== 'importbook'
          && (req.tenantAuthInfo || {}).domain !== util.getIDPDomain(req.headers)
        ) {
          throw new Error(`invalid_tenant_auth`)
        }

        if(!req.tenantAuthInfo && !req.user.isAdmin) {
          throw new Error(`no_permission`)
        }

        const putEPUBFile = async (relfilepath, body) => {
          const key = /^epub_content\/covers\//.test(relfilepath)
            ? relfilepath
            : `epub_content/book_${bookRow.id}/${relfilepath}`
          
          log(['Upload file to S3', key])
  
          await s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: body,
            ContentLength: body.byteCount,
            ContentType: mime.getType(key),
          }).promise()
  
          log(['...uploaded to S3', key])
        }
  
        const getEPUBFilePaths = path => {
          if(fs.existsSync(path)) {
            fs.readdirSync(path).forEach(file => {
              const curPath = `${path}/${file}`
              if(fs.lstatSync(curPath).isDirectory()) { // recurse
                getEPUBFilePaths(curPath)
              } else {
                epubFilePaths.push(curPath)
              }
            })
          }
        }
    
        const filename = file.originalFilename

        if(!filename) {
          throw new Error(`invalid_filename`)
        }

        const priceMatch = filename.match(/\$([0-9]+)\.([0-9]{2})(\.[^\.]+)?$/)
        const epubSizeInMebibyte = Math.ceil(file.size/1024/1024)

        if(epubSizeInMebibyte > req.user.idpMaxMBPerBook) {
          throw new Error(`file_too_large`)
        }

        bookRow = {
          title: 'Unknown',
          author: '',
          isbn: '',
          epubSizeInMB: epubSizeInMebibyte,
          standardPriceInCents: priceMatch ? (priceMatch[1] + priceMatch[2]) : null,
          updated_at: util.timestampToMySQLDatetime()
        }

        // Put row into book table
        log(['Insert book row', bookRow], 2)
        bookRow.id = (await util.runQuery({
          query: 'INSERT INTO `book` SET ?',
          vars: bookRow,
          next,
        })).insertId

        await emptyS3Folder(`epub_content/book_${bookRow.id}/`)

        deleteFolderRecursive(toUploadDir)

        fs.mkdirSync(toUploadDir)

        const zip = new admzip(file.path)
        zip.extractAllTo(toUploadDir)

        fs.renameSync(file.path, `${toUploadDir}/book.epub`)

        getEPUBFilePaths(toUploadDir)
        await Promise.all(epubFilePaths.map(path => (
          putEPUBFile(path.replace(toUploadDir + '/', ''), fs.createReadStream(path))
        )))

        // TODO: make fonts public

        // after files uploaded
        const { title, author, isbn, coverHref, spines, success } = await parseEpub({ baseUri: toUploadDir, log })

        if(!success) {
          throw Error(`unable_to_process`)
        }

        // prep to insert the book row
        bookRow.title = title || 'Unknown'
        bookRow.author = author || ''
        bookRow.isbn = isbn || ''
        bookRow.updated_at = util.timestampToMySQLDatetime()

        // create and save search index
        let indexObj, searchTermCounts, noOfflineSearch
        try {
          const indexedBook = await getIndexedBook({ baseUri: toUploadDir, spines, log })
          if(!indexedBook.noOfflineSearch) {
            await putEPUBFile('search_index.json', indexedBook.jsonStr)
          }
          indexObj = indexedBook.indexObj
          searchTermCounts = indexedBook.searchTermCounts
          noOfflineSearch = indexedBook.noOfflineSearch
        } catch(e) {
          log(e.message, 3)
          if(/^Search indexing taking too long/.test(e.message)) {
            throw Error(`search_indexing_too_slow`)
          } else if(/^EPUB content too massive/.test(e.message)) {
            throw Error(`text_content_too_massive_for_search_indexing`)
          } else if(/^EPUB search index overloading memory/.test(e.message)) {
            throw Error(`search_indexing_memory_overload`)
          } else {
            throw Error(`search_indexing_failed`)
          }
        }

        // check if book already exists in same idp group
        log('Look for identical book in idp group')
        const rows = await util.runQuery({
          query: `
            SELECT
              b.*,
              IF(bi.idp_id=:idpId, 1, 0) as alreadyBookInThisIdp

            FROM book as b
              LEFT JOIN \`book-idp\` as bi ON (b.id = bi.book_id)
              LEFT JOIN idp_group_member as igm1 ON (bi.idp_id = igm1.idp_id)
              LEFT JOIN idp_group_member as igm2 ON (igm1.idp_group_id = igm2.idp_group_id)

            WHERE b.title=:title
              AND b.author=:author
              AND b.isbn=:isbn
              AND (
                bi.idp_id=:idpId
                OR igm2.idp_id=:idpId
              )

            ORDER BY alreadyBookInThisIdp DESC

            LIMIT 1
          `,
          vars: {
            ...bookRow,
            idpId: req.user.idpId,
          },
          next,
        })

        if(rows.length === 1 && !replaceExisting) {

          // clean up
          deleteFolderRecursive(tmpDir)

          // delete book
          await deleteBook(bookRow.id, next)

          const responseBase = {
            success: true,
            bookId: rows[0].id,
            noOfflineSearch,  // not 100% accurate, but leaving it for now
            title: rows[0].title,
            author: rows[0].author,
            isbn: rows[0].isbn || '',
            thumbnailHref: (
              /^epub_content\/covers\//.test(rows[0].coverHref || ``)
                ? `${util.getFrontendBaseUrl(req)}/${rows[0].coverHref}`
                : `${util.getFrontendBaseUrl(req)}/epub_content/covers/book_${rows[0].id}.png`  // this also was the old way of doing things
            ),
            epubSizeInMB: rows[0].epubSizeInMB,
          }

          if(rows[0].alreadyBookInThisIdp == '1') {
            log('Import unnecessary (book already associated with this idp)', 2)
            res.send({
              ...responseBase,
              note: 'already-associated',
            })

          } else {
            const vars = cleanUpBookIdpToDelete = {
              book_id: rows[0].id,
              idp_id: req.user.idpId
            }
            log(['INSERT book-idp row', vars], 2)
            await util.runQuery({
              query: 'INSERT INTO `book-idp` SET ?',
              vars,
              next,
            })

            await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: rows[0].id, log })

            log('Import unnecessary (book exists in idp with same group; added association)', 2)
            res.send({
              ...responseBase,
              note: 'associated-to-existing',
            })

          }
          
          return
        }

        if(replaceExisting) {
          const row = rows[0]

          if(!row || row.alreadyBookInThisIdp != '1') {
            throw new Error(`does-not-exist`)
          }

          // copy the old s3 dir to `book_XX--replaced-[timestamp]`
          await util.s3CopyFolder({
            source: `epub_content/book_${row.id}/`,
            destination: `epub_content/book_${row.id}--replaced-${Date.now()}/`,
          })

          // copy new s3 dir to where old was
          await util.s3CopyFolder({
            source: `epub_content/book_${bookRow.id}/`,
            destination: `epub_content/book_${row.id}/`,
          })

          // delete the new book
          await deleteBook(bookRow.id, next)

          // delete the search index rows for the old book
          deleteBookSearchIndexRows(row.id, next)

          // change bookRow.id so that the existing row gets updated
          bookRow.id = row.id

        } else {
          const vars = cleanUpBookIdpToDelete = {
            book_id: bookRow.id,
            idp_id: req.user.idpId,
          }
          log(['INSERT book-idp row', vars], 2)
          await util.runQuery({
            query: 'INSERT INTO `book-idp` SET ?',
            vars,
            next,
          })
        }

        // From this point, we expect it to be successful. Send some info to keep the connection alive.
        beganResponse = true
        res.set('Content-Type', 'application/json')
        res.write(`{`)
        let timeOfLastResponseWrite = Date.now()
        let writeResponseIndex = 0
        const addToResponseToKeepAlive = () => {
          if(Date.now() > timeOfLastResponseWrite + 1000*30) {
            res.write(`"ignore-${writeResponseIndex++}":0,`)
            timeOfLastResponseWrite = Date.now()
          }
        }

        const numInsertsAtOnce = 500

        // save search index to db (needs to be down here after bookRow.id gets updated if replaceExisting is true)
        const storedFields = Object.values(indexObj.storedFields)
        for(let i=0; i<storedFields.length; i+=numInsertsAtOnce) {
          const chunk = storedFields.slice(i, i+numInsertsAtOnce)

          util.convertJsonColsToStrings({ tableName: 'book_textnode_index', rows: chunk })

          log([`INSERT ${numInsertsAtOnce} book_textnode_index rows from index ${i}...`], 2)
          await util.runQuery({
            query: `INSERT INTO book_textnode_index (id, book_id, spineIdRef, text, hitIndex, context) VALUES ${chunk.map(x => `(?,?,?,?,?,?)`).join(',')}`,
            vars: chunk.map(textnodeInfo => ([
              textnodeInfo.id,
              bookRow.id,
              textnodeInfo.spineIdRef,
              textnodeInfo.text,
              textnodeInfo.hitIndex,
              textnodeInfo.context,
            ])).flat(),
            next,
          })

          addToResponseToKeepAlive()
        }

        // save search index terms to db (needs to be down here after bookRow.id gets updated if replaceExisting is true)
        const searchTerms = Object.keys(searchTermCounts)
          .filter(searchTerm => searchTermCounts[searchTerm])
        for(let i=0; i<searchTerms.length; i+=numInsertsAtOnce) {
          const chunk = searchTerms.slice(i, i+numInsertsAtOnce)

          log([`INSERT ${numInsertsAtOnce} book_textnode_index_term rows from index ${i}...`], 2)
          await util.runQuery({
            query: `INSERT INTO book_textnode_index_term (term, count, book_id) VALUES ${chunk.map(x => `(?,?,?)`).join(',')}`,
            vars: chunk.map(searchTerm => ([
              searchTerm,
              searchTermCounts[searchTerm],
              bookRow.id,
            ])).flat(),
            next,
          })

          addToResponseToKeepAlive()
        }

        // following block needs to be down here after bookRow.id gets updated if replaceExisting is true
        bookRow.rootUrl = `epub_content/book_${bookRow.id}`
        if(coverHref) {
          const fileType = getImageFileType(coverHref)
          bookRow.coverHref = `epub_content/covers/${uuidv4()}.${fileType}`
          // Width of 480 is twice that of the ~240px max width for the most recent book
          const imgData = await getAdjustedImageBody(`${toUploadDir}/${coverHref}`, fileType, 480)
          await putEPUBFile(bookRow.coverHref, imgData)
        }

        // clean up
        deleteFolderRecursive(tmpDir)

        log(['Update book row', bookRow.id, bookRow], 2)
        await util.runQuery({
          query: 'UPDATE `book` SET :bookRow WHERE id=:bookId',
          vars: {
            bookId: bookRow.id,
            bookRow,
          },
          next,
        })

        await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: bookRow.id, log })

        log('Import successful', 2)
        try {  // If everything was successful, but the connection timed out, don't delete it.
          res.write(
            `"success": true,` +
            (noOfflineSearch ? `"noOfflineSearch": true,` : ``) +
            `"bookId": ${bookRow.id},` +
            `"title": "${bookRow.title.replace(/"/g, '\\"')}",` +
            `"author": "${bookRow.author.replace(/"/g, '\\"')}",` +
            `"isbn": "${(bookRow.isbn || '').replace(/"/g, '\\"')}",` +
            `"thumbnailHref": "${util.getFrontendBaseUrl(req)}/${bookRow.coverHref}",` +
            `"epubSizeInMB": ${bookRow.epubSizeInMB}` +
            `}`
          )
          res.end()
        } catch(e) {}

      } catch(err) {

        log(['Import book exception', err.message], 3)
  
        // clean up...
  
        try {
          if(cleanUpBookIdpToDelete) {
            await util.runQuery({
              query: 'DELETE FROM `book-idp` WHERE idp_id=:idp_id AND book_id=:book_id',
              vars: cleanUpBookIdpToDelete,
              next,
            })
          }
        } catch(err2) {}
  
        try {

          if(bookRow) {
            await deleteBookIfUnassociated(bookRow.id, next)
            await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: bookRow.id, log })
          }

          deleteFolderRecursive(tmpDir)
  
        } catch(err3) {
          log(['Error in responding to import error!', err3.message], 3)
        }

        if(beganResponse) {
          res.write(
              `"success": false` +
            `}`
          )
          res.end()
        } else {
          res.status(400).send({
            errorType: /^[-_a-z]+$/.test(err.message) ? err.message : "unable_to_process",
            maxMB: req.user.idpMaxMBPerBook,
          })
        }
      }
  
    })

    form.on('error', err => {
      res.status(400).send({ errorType: `bad_file` })
    })

    form.parse(req)

  })

  // import file
  app.post(
    '/importfile/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next)  => {

      const { classroomUid } = req.params

      await util.dieOnNoClassroomEditPermission({
        next,
        req,
        log,
        classroomUid,
      })

      const tmpDir = baseTmpDir + '/tmp_file_' + util.getUTCTimeStamp()

      deleteFolderRecursive(tmpDir)

      fs.mkdir(tmpDir, err => {
        if(err) return next(err)

        const form = new multiparty.Form({
          uploadDir: tmpDir,
        })

        let processedOneFile = false  // at this point, we only allow one upload at a time

        form.on('file', (name, file) => {

          if(processedOneFile) return
          processedOneFile = true

          const filename = file.originalFilename
            .replace(/[^a-z0-9._-]/gi, '')
            .replace(/(\.[^.]+)$/gi, `-${Date.now()}$1`)

          if(!filename || !/-[0-9]+\.[^.]+$/.test(filename)) {
            deleteFolderRecursive(tmpDir)
            res.status(400).send({ errorType: "invalid_filename" })
            return
          }

          const fileSizeInMebibyte = Math.ceil(file.size/1024/1024)

          if(fileSizeInMebibyte > req.user.idpMaxMBPerFile) {
            res.status(400).send({
              errorType: "file_too_large",
              maxMB: req.user.idpMaxMBPerFile,
            })
            return
          }

          const body = fs.createReadStream(file.path)

          const key = 'enhanced_assets/' + classroomUid + '/' + filename
          log(['Upload file to S3', key])
          s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: body,
            ContentLength: body.byteCount,
            ContentType: mime.getType(key),
          }, (err, data) => {
            // clean up
            deleteFolderRecursive(tmpDir)

            if(err) return next(err)

            res.send({
              success: true,
              filename,
            })
          })

        })

        form.on('error', err => {
          log(['importfile error', err], 3)
          deleteFolderRecursive(tmpDir)
          res.status(400).send({ errorType: "bad_file" })
        })

        form.parse(req)

      })

    }
  )

  // get (and optionally update) the subscription rows
  app.all('/subscriptions', async (req, res, next) => {

    if(![ 'GET', 'POST' ].includes(req.method)) return next()

    if(req.method === 'POST') {

      if(!(req.user || {}).isAdmin) {
        log('No permission to update subscriptions', 3)
        res.status(403).send({ errorType: "no_permission" })
        return
      }

      if(
        !util.paramsOk(req.body, ['subscriptions'])
        || !(req.body.subscriptions instanceof Array)
        || req.body.subscriptions.some(subscription => (
          !util.paramsOk(subscription, ['label'])  // a new key
          && !util.paramsOk(subscription, ['id', 'label'])  // an update
        ))
      ) {
        log(['Invalid parameter(s)', req.body], 3)
        res.status(400).send()
        return
      }

      let vars = {
        idpId: req.user.idpId,
        now: util.timestampToMySQLDatetime(),
        [`delete_except_ids`]: [
          0,  // dummy key to ensure valid sql
          ...req.body.subscriptions.map(({ id }) => id).filter(Boolean),
        ],
      }

      const queries = [

        `UPDATE subscription SET deleted_at=:now WHERE idp_id=:idpId AND id NOT IN (:delete_except_ids) AND deleted_at IS NULL`,

        ...req.body.subscriptions.map((subscription, idx) => {
          const { id, label } = subscription

          if(!id) {
            vars = {
              ...vars,
              [`insert_${idx}`]: {
                ...subscription,
                idp_id: req.user.idpId,
              },
            }
            return `INSERT INTO subscription SET :insert_${idx}`

          } else {
            vars = {
              ...vars,
              [`update_values_${id}`]: {
                label,
              },
              [`update_${id}`]: id,
            }
            return `UPDATE subscription SET :update_values_${id} WHERE idp_id=:idpId AND id=:update_${id}`
          }
        }),

      ]

      await util.runQuery({
        queries,
        vars,
        next,
      })

    }

    // get the subscriptions

    const subscriptions = await util.runQuery({
      query: `
        SELECT s.id, s.label
        FROM subscription AS s
          LEFT JOIN idp AS i ON (i.id = s.idp_id)
        WHERE i.domain=:domain
          AND s.deleted_at IS NULL
        ORDER BY s.label
      `,
      vars: {
        domain: util.getIDPDomain(req.headers),  // they may not be logged in, and so we find this by domain and not idpId
      },
      next,
    })

    res.send({ subscriptions })

  })

  // create or update an audiobook
  app.post('/audiobook', async (req, res, next) => {

    if(!(req.user || {}).isAdmin) {
      log('No permission to create/update audiobooks', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    if(
      !util.paramsOk(req.body, ['book'])
      || typeof req.body.book !== `object`
      || !util.paramsOk(req.body.book, ['audiobookInfo'], ['id', 'title', 'author', 'isbn', 'coverHref'])
      || typeof req.body.book.audiobookInfo !== `object`
      || !util.paramsOk(req.body.book.audiobookInfo, ['spines'], ['coverFilename'])  // coverFilename is needed for old audiobooks
    ) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    let epubSizeInMebibyte = 0
    await Promise.all(req.body.book.audiobookInfo.spines.map(async ({ filename }) => {
      const data = await s3.getObjectAttributes({
        Bucket: process.env.S3_BUCKET,
        Key: `epub_content/book_${req.body.book.id}/${filename}`,
        ObjectAttributes: [ `ObjectSize` ],
      }).promise()
      epubSizeInMebibyte += data.ObjectSize/1024/1024
    }))
    epubSizeInMebibyte = Math.ceil(epubSizeInMebibyte)

    if(epubSizeInMebibyte > MAX_AUDIOBOOK_MEBIBYTE) {
      res.status(400).send({
        errorMessage: `Total size of this audiobook exceeds ${MAX_AUDIOBOOK_MEBIBYTE} MiB max.`,
      })
      return
    }

    bookRow = {
      ...req.body.book,
      epubSizeInMB: epubSizeInMebibyte,
      updated_at: util.timestampToMySQLDatetime()
    }

    util.convertJsonColsToStrings({ tableName: 'book', row: bookRow })

    if(!req.body.book.id) {  // extra stuff for initial insert

      log(['Insert book row', bookRow], 2)
      bookRow.id = (await util.runQuery({
        query: 'INSERT INTO `book` SET ?',
        vars: bookRow,
        next,
      })).insertId

      bookRow.rootUrl = `epub_content/book_${bookRow.id}`

      const bookIdpRow = {
        book_id: bookRow.id,
        idp_id: req.user.idpId,
      }

      log(['INSERT book-idp row', bookIdpRow], 2)
      await util.runQuery({
        query: 'INSERT INTO `book-idp` SET ?',
        vars: bookIdpRow,
        next,
      })

      await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: bookRow.id, log })

    }

    log(['Update book row', bookRow.id, bookRow], 2)
    await util.runQuery({
      query: 'UPDATE `book` SET :bookRow WHERE id=:bookId',
      vars: {
        bookId: bookRow.id,
        bookRow,
      },
      next,
    })

    return util.getLibrary({ req, res, next, log, newBookId: bookRow.id })

  })

  // upload audiobook file (or a new cover image for an ebook)
  app.post('/audiobookfile/:bookId', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!(req.user || {}).isAdmin) {
      log('No permission to upload audiobook files', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    const { bookId } = req.params

    // check that this IDP has access to this book and also see if it is an audiobook

    const [ bookRows, bookIdpRows ] = await util.runQuery({
      queries: [
        'SELECT * FROM `book` WHERE id=:bookId LIMIT 1',
        'SELECT * FROM `book-idp` WHERE book_id=:bookId AND idp_id=:idpId LIMIT 1',
      ],
      vars: {
        idpId: req.user.idpId,
        bookId,
      },
      next,
    })

    if(bookId !== `new` && (bookIdpRows.length !== 1 || bookRows.length !== 1)) {
      log(['Book ID not associated with this client', req.body], 3)
      res.status(400).send()
      return
    }

    const isAudiobook = !bookRows[0] || !!bookRows[0].audiobookInfo

    const tmpDir = baseTmpDir + 'tmp_file_' + util.getUTCTimeStamp()

    deleteFolderRecursive(tmpDir)

    fs.mkdir(tmpDir, err => {
      if(err) return next(err)

      const form = new multiparty.Form({
        uploadDir: tmpDir,
      })

      let processedOneFile = false  // at this point, we only allow one upload at a time

      form.on('file', async (name, file) => {

        const isCoverImage = /^image\//.test(mime.getType(file.originalFilename))

        if(processedOneFile) return
        processedOneFile = true

        const extension = (file.originalFilename.match(/\.[^.]+$/gi) || [])[0]

        let filename, key, body, durationMS

        if(isCoverImage) {

          const fileType = getImageFileType(file.path)
          filename = `${uuidv4()}.${fileType}`
          key = `epub_content/covers/${filename}`
          body = await getAdjustedImageBody(file.path, fileType, ...(isAudiobook ? [ 800, 800 ] : [ 480 ]))

        } else {

          if(Math.ceil(file.size/1024/1024) > MAX_AUDIOBOOK_FILE_MEBIBYTE) {
            res.status(400).send({
              errorType: "file_too_large",
              maxMB: MAX_AUDIOBOOK_FILE_MEBIBYTE,
            })
            return
          }

          filename = `${uuidv4()}${extension}`
          key = `epub_content/book_${bookId}/${filename}`
          body = fs.createReadStream(file.path)

          const metadata = await mm.parseStream(fs.createReadStream(file.path), { mimeType: mime.getType(key), size: body.byteCount }, { duration: true })
          durationMS = parseInt(metadata.format.duration * 1000, 10)

        }

        log(['Upload audiobook file to S3', key])

        await s3.putObject({
          Bucket: process.env.S3_BUCKET,
          Key: key,
          Body: body,
          ContentLength: body.byteCount,
          ContentType: mime.getType(key),
        }).promise()

        log(['...uploaded audiobook file to S3', key])

        res.send({
          success: true,
          filename,
          fileSizeInMB: Math.round(file.size/1024/1024),
          durationMS,
        })

      })

      form.on('error', err => {
        log(['audiobookfile error', err], 3)
        deleteFolderRecursive(tmpDir)
        res.status(400).send({ errorType: "bad_file" })
      })

      form.parse(req)

    })

  })

  // update subscription-book rows
  app.post('/setsubscriptions/:bookId', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to modify subscriptions', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    if(
      !util.paramsOk(req.body, ['subscriptions'])
      || req.body.subscriptions.some(subscription => !util.paramsOk(subscription, ['id', 'version']))
    ) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    const [ currentSubscriptionBookRows, bookOnIdp, subscriptionOnIdp ] = await util.runQuery({
      query: `
        SELECT sb.subscription_id, sb.version
        FROM \`subscription-book\` as sb
          LEFT JOIN subscription as s ON (s.id=sb.subscription_id)
          LEFT JOIN \`book-idp\` as bi ON (bi.book_id=sb.book_id)
        WHERE bi.book_id=:bookId
          AND bi.idp_id=:idpId
          AND (
            sb.subscription_id=:negativeIdpId
            OR (
              s.idp_id=:idpId
              AND s.deleted_at IS NULL
            )
          )
        ;

        SELECT bi.book_id
        FROM \`book-idp\` as bi
        WHERE bi.book_id=:bookId
          AND bi.idp_id=:idpId
        ;

        SELECT s.id
        FROM subscription as s
        WHERE s.idp_id=:idpId
          AND s.deleted_at IS NULL
      `,
      vars: {
        bookId: req.params.bookId,
        idpId: req.user.idpId,
        negativeIdpId: req.user.idpId * -1,
      },
      next,
    })

    if(bookOnIdp.length === 0) {
      log('No permission to modify subscriptions on this book', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    const subscriptionIdOptions = subscriptionOnIdp.map(({ id }) => id)
    let { subscriptions } = req.body
    const queries = []
    const vars = []

    // delete old
    currentSubscriptionBookRows.forEach(({ subscription_id }) => {
      if(!subscriptions.some(({ id }) => id === subscription_id)) {
        queries.push(`DELETE FROM \`subscription-book\` WHERE subscription_id=? AND book_id=?`)
        vars.push(subscription_id)
        vars.push(req.params.bookId)
      }
    })

    // update existing
    subscriptions = subscriptions.filter(subscription => (
      !currentSubscriptionBookRows.some(({ subscription_id, version }) => {
        if(subscription_id === subscription.id) {
          if(subscription.version !== version) {
            queries.push(`UPDATE \`subscription-book\` SET version=? WHERE subscription_id=? AND book_id=?`)
            vars.push(version)
            vars.push(subscription_id)
            vars.push(req.params.bookId)
          }
          return true
        }
      })
    ))

    // add new
    if(subscriptions.some(({ id, version }) => {
      if(
        id !== req.user.idpId * -1
        && !subscriptionIdOptions.includes(id)
      ) {
        return true
      }
      queries.push(`INSERT INTO \`subscription-book\` SET ?`)
      vars.push({
        subscription_id: id,
        version,
        book_id: req.params.bookId,
      })
    })) {
      log('No permission to add requested subscription', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    await util.runQuery({
      queries,
      vars,
      next,
    })

    await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: req.params.bookId, log })

    res.send({ success: true })

  })

  // get (and optionally update) the metadata_key rows
  app.all('/metadatakeys', async (req, res, next) => {

    if(![ 'GET', 'POST' ].includes(req.method)) return next()

    if(req.method === 'POST') {

      if(!(req.user || {}).isAdmin) {
        log('No permission to update metadata keys', 3)
        res.status(403).send({ errorType: "no_permission" })
        return
      }

      if(
        !util.paramsOk(req.body, ['metadataKeys'])
        || !(req.body.metadataKeys instanceof Array)
        || req.body.metadataKeys.some(metadataKey => (
          !util.paramsOk(metadataKey, ['name'], ['options'])  // a new key
          && !util.paramsOk(metadataKey, ['id', 'name'], ['options'])  // an update
        ))
      ) {
        log(['Invalid parameter(s)', req.body], 3)
        res.status(400).send()
        return
      }

      util.convertJsonColsToStrings({ tableName: 'metadata_key', rows: req.body.metadataKeys })

      let vars = {
        idpId: req.user.idpId,
        now: util.timestampToMySQLDatetime(),
        [`delete_except_ids`]: [
          0,  // dummy key to ensure valid sql
          ...req.body.metadataKeys.map(({ id }) => id).filter(Boolean),
        ],
      }

      const queries = [

        `UPDATE metadata_key SET deleted_at=:now WHERE idp_id=:idpId AND id NOT IN (:delete_except_ids) AND deleted_at IS NULL`,

        ...req.body.metadataKeys.map((metadataKey, idx) => {
          const { id, name, options } = metadataKey

          if(!id) {
            vars = {
              ...vars,
              [`insert_${idx}`]: {
                ...metadataKey,
                ordering: idx + 1,
                idp_id: req.user.idpId,
              },
            }
            return `INSERT INTO metadata_key SET :insert_${idx}`

          } else {
            vars = {
              ...vars,
              [`update_values_${id}`]: {
                name,
                options,
                ordering: idx + 1,
              },
              [`update_${id}`]: id,
            }
            return `UPDATE metadata_key SET :update_values_${id} WHERE idp_id=:idpId AND id=:update_${id}`
          }
        }),

      ]

      await util.runQuery({
        queries,
        vars,
        next,
      })

    }

    // get the metadata keys

    const metadataKeys = await util.runQuery({
      query: `
        SELECT mk.id, mk.name, mk.options
        FROM metadata_key AS mk
          LEFT JOIN idp AS i ON (i.id = mk.idp_id)
        WHERE i.domain=:domain
          AND mk.deleted_at IS NULL
        ORDER BY mk.ordering
      `,
      vars: {
        domain: util.getIDPDomain(req.headers),  // they may not be logged in, and so we find this by domain and not idpId
      },
      next,
    })

    util.convertJsonColsFromStrings({ tableName: 'metadata_key', rows: metadataKeys })

    metadataKeys.forEach(metadataKey => {
      if(!metadataKey.options) {
        delete metadataKey.options
      }
    })

    res.send({ metadataKeys })

  })

  // update the metadata_key rows
  app.post('/metadatavalues', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to update metadata values', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    if(
      !util.paramsOk(req.body, ['bookId', 'metadataValues'])
      || !(req.body.metadataValues instanceof Array)
      || req.body.metadataValues.some(metadataValue => (
        !util.paramsOk(metadataValue, ['metadata_key_id', 'value'])
        || /\r/.test(metadataValue)
      ))
    ) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    const vars = {
      idpId: req.user.idpId,
      bookId: req.body.bookId,
      bookUpdate: {
        id: req.body.bookId,  // this is here in case neither title, author, nor isbn is sent, to prevent the update from failing
      },
    }

    const bookIdpRows = await util.runQuery({
      query: 'SELECT * FROM `book-idp` WHERE book_id=:bookId AND idp_id=:idpId LIMIT 1',
      vars,
      next,
    })

    if(bookIdpRows.length !== 1) {
      log(['Book ID not associated with this client', req.body], 3)
      res.status(400).send()
      return
    }

    const otherMetadataValues = []
    req.body.metadataValues.forEach(metadataValue => {
      if([ 'title', 'author', 'isbn', 'coverHref' ].includes(metadataValue.metadata_key_id)) {
        vars.bookUpdate[metadataValue.metadata_key_id] = `${metadataValue.value || ``}`
      } else {
        otherMetadataValues.push(metadataValue)
      }
    })

    const queries = [

      `START TRANSACTION`,

      `UPDATE book SET :bookUpdate WHERE id=:bookId`,

      `
        DELETE FROM metadata_value
        WHERE book_id=:bookId
          AND metadata_key_id IN (
            SELECT mk.id
            FROM metadata_key AS mk
            WHERE mk.idp_id=:idpId
              AND mk.deleted_at IS NULL
          )
      `,

      ...otherMetadataValues.map(({ metadata_key_id, value }, idx) => {
        vars[`insert_${idx}`] = {
          book_id: vars.bookId,
          metadata_key_id,
          value,
        }
        return `INSERT INTO metadata_value SET :insert_${idx}`
      }),

      `COMMIT`,

    ]

    await util.runQuery({
      queries,
      vars,
      next,
    })

    return util.getLibrary({ req, res, next, log })

  })

  // usage costs
  app.get('/reportsinfo', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to view usage costs', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    const reportInfo = []
    const isTRSite = req.user.idpId == 21  // books.toadreader.com

    const idpRows = await util.runQuery({
      query:       `
        SELECT i.*
        FROM idp as i
        ${isTRSite ? `` : `
          WHERE i.id=:idpId
        `}
      `,
      vars: {
        idpId: req.user.idpId,
      },
      next,
    })

    for(let idpIndex=0; idpIndex < idpRows.length; idpIndex++) {

      reportInfo.push({
        tab: idpRows[idpIndex].name,
        data: [],
      })

      const date = new Date()
      date.setMonth(date.getMonth() + 1)

      for(let i=0; i<(req.query.numMonths || 6); i++) {

        const toDate = `${date.getUTCFullYear()}-${util.pad(date.getUTCMonth() + 1, 2)}-01 00:00:00`
        date.setMonth(date.getMonth() - 1)
        const fromDate = `${date.getUTCFullYear()}-${util.pad(date.getUTCMonth() + 1, 2)}-01 00:00:00`
        const heading = date.toLocaleString('default', { month: 'long', year: 'numeric' })

        if(new Date(fromDate) < new Date(idpRows[idpIndex].created_at)) break

        let activeUsersRows = await util.runQuery({
          query: `
            SELECT COUNT(*) AS numActiveUsers
            FROM user as u
            WHERE u.idp_id=:idpId
              AND (
                SELECT id
                FROM reading_session as rs
                WHERE rs.user_id=u.id
                  AND rs.read_at>=:fromDate
                  AND rs.read_at<:toDate
                LIMIT 1
              ) IS NOT NULL
          `,
          vars: {
            idpId: idpRows[idpIndex].id,
            fromDate,
            toDate,
          },
          next,
        })

        const useEnhancedReader = idpRows[idpIndex].use_enhanced_reader_at && new Date(idpRows[idpIndex].use_enhanced_reader_at) < new Date(toDate)
        const useAudiobooks = idpRows[idpIndex].use_audiobooks_at && new Date(idpRows[idpIndex].use_audiobooks_at) < new Date(toDate)
        const useEnhancedReaderOrAudiobook = !!(useEnhancedReader || useAudiobooks)
        const numActiveUsers = parseInt(activeUsersRows[0].numActiveUsers, 10)
        let totalCostInCents

        if(idpRows[idpIndex].specialPricing === 'OLD' && !useEnhancedReaderOrAudiobook) {

          if(i === 0) {
            reportInfo[idpIndex].data.push({
              heading: `MONTHLY FEE (old pricing; valid through Nov 2021)\n\n    $0.25 per active user\n    Minimum: $100`,
              rows: [],
            })
          }

          totalCostInCents = Math.max(100 * 100, 25 * numActiveUsers)

        } else if(idpRows[idpIndex].specialPricing === 'ORIG-ORCA') {

          if(i === 0) {
            reportInfo[idpIndex].data.push({
              heading: `PRICING (custom)\n\n    $1 per active user\n    Minimum: $1000`,
              rows: [],
            })
          }

          totalCostInCents = Math.max(1000 * 100, 100 * numActiveUsers)

        } else {

          if(i === 0) {

            const costChartRows = [
              {
                'Active users': 'Up to 1,000',
                'Standard eReader': '$250 per month',
                'Interactive eReader / Audiobooks': '$700 per month',
              },
              {
                'Active users': '1,001 - 2,000',
                'Standard eReader': '$400 per month',
                'Interactive eReader / Audiobooks': '$1200 per month',
              },
              {
                'Active users': '2,001 - 5,000',
                'Standard eReader': '$750 per month',
                'Interactive eReader / Audiobooks': '$2000 per month',
              },
              {
                'Active users': '5,001 - 10,000',
                'Standard eReader': '$1000 per month',
                'Interactive eReader / Audiobooks': '$3000 per month',
              },
              {
                'Active users': '10,000+',
                'Standard eReader': '$0.10 per active user per month',
                'Interactive eReader / Audiobooks': '$0.30 per active user per month',
              },
            ]

            if(idpRows[idpIndex].specialPricing === 'NON-PROFIT') {
              costChartRows.unshift({
                'Active users': 'Up to 400',
                'Standard eReader': '$100 per month',
                'Interactive eReader / Audiobooks': '$280 per month',
              })
              costChartRows[1]['Active users'] = '401 - 1,000'
            }

            reportInfo[idpIndex].data.push({
              heading: `Pricing Chart${idpRows[idpIndex].specialPricing === 'NON-PROFIT' ? ` (non-profit)` : ``}`,
              rows: costChartRows,
            })

          }

          if(numActiveUsers <= 400 && idpRows[idpIndex].specialPricing === 'NON-PROFIT') {
            totalCostInCents = (useEnhancedReaderOrAudiobook ? 280 : 100) * 100
          } else if(numActiveUsers <= 1000) {
            totalCostInCents = (useEnhancedReaderOrAudiobook ? 700 : 250) * 100
          } else if(numActiveUsers <= 2000) {
            totalCostInCents = (useEnhancedReaderOrAudiobook ? 1200 : 400) * 100
          } else if(numActiveUsers <= 5000) {
            totalCostInCents = (useEnhancedReaderOrAudiobook ? 2000 : 750) * 100
          } else if(numActiveUsers <= 10000) {
            totalCostInCents = (useEnhancedReaderOrAudiobook ? 3000 : 1000) * 100
          } else {
            totalCostInCents = (useEnhancedReaderOrAudiobook ? (30 * numActiveUsers) : (10 * numActiveUsers))
          }

        }

        if(i === 0) {
          reportInfo[idpIndex].data.push({
            heading: `Note: Monthly fees are billed at the beginning of each month for that same month. Bills must be paid within 15 days of when they are issued. The fee level will be based on the previous month’s usage. When relevant, it will also include an adjustment for the previous month if actual usage did not coincide with the estimated amount.`,
            rows: [],
          })
        }

        reportInfo[idpIndex].data.push({
          heading: `${heading} – Usage Cost ${i === 0 ? `(not yet complete)` : ``}`,
          rows: [
            {
              'eReader version': useEnhancedReaderOrAudiobook ? `Interactive eReader / Audiobooks` : `Standard eReader`,
              'Active users': numActiveUsers,
              'Fee': `$${totalCostInCents}`.replace(/(..)$/, '\.$1'),
            },
          ],
        })

      }

      // build out user list
      if(!isTRSite) {

        const userRows = await util.runQuery({
          query:       `
            SELECT
              u.email as Email,
              u.fullname as Name,
              u.created_at as Created
            FROM user as u
            WHERE u.idp_id=:idpId
              AND u.adminLevel!="SUPER_ADMIN"
          `,
          vars: {
            idpId: idpRows[idpIndex].id,
          },
          next,
        })

        userRows.forEach(userRow => {
          userRow.Created = userRow.Created.split(" ")[0]
        })

        reportInfo[idpIndex].data.push({
          heading: `User List`,
          rows: userRows,
          summary: `Total number of users: ${userRows.length}`,
        })

      }

    }

    log('Deliver the report')
    res.send(reportInfo)

  })

  // user search
  app.get('/usersearch', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to search users', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    if(typeof req.query.searchStr !== 'string') {
      log(['Invalid parameter(s)', req.query], 3)
      res.status(400).send()
      return
    }

    const users = await util.runQuery({
      query: `
        SELECT u.id, u.user_id_from_idp, u.email, u.fullname, u.adminLevel
        FROM user AS u
        WHERE
          (
            u.id = :searchStr
            OR u.user_id_from_idp = :searchStr
            OR u.email LIKE :likeSearchStr
            OR u.fullname LIKE :likeSearchStr
          )
          AND u.idp_id = :idpId
          AND u.id > 0
          ${!req.query.adminsOnly ? `` : `
            AND u.adminLevel="ADMIN"
          `}
        ORDER BY u.email
        LIMIT 10
      `,
      vars: {
        idpId: req.user.idpId,
        searchStr: req.query.searchStr,
        likeSearchStr: `${req.query.searchStr.replace(/([_%])/g, '\\$1')}%`,
      },
      next,
    })

    log('Deliver user search results')
    res.send(users)

  })

  // common books on associated sites
  app.get('/groupmemberswithcommonbooks', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to get accociated sites', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    const rows = await util.runQuery({
      query: `
        SELECT
          igm2.idp_id AS idpId,
          i.name,
          i.domain,
          b.*

        FROM idp_group_member as igm1
          LEFT JOIN idp_group_member as igm2 ON (igm1.idp_group_id = igm2.idp_group_id)
          LEFT JOIN \`book-idp\` as bi1 ON (igm1.idp_id = bi1.idp_id)
          LEFT JOIN \`book-idp\` as bi2 ON (igm2.idp_id = bi2.idp_id)
          LEFT JOIN book as b ON (bi2.book_id = b.id)
          LEFT JOIN idp as i ON (igm2.idp_id = i.id)

        WHERE igm1.idp_id=:idpId
          AND bi1.book_id=bi2.book_id
          AND igm2.idp_id!=:idpId
      `,
      vars: {
        idpId: req.user.idpId,
      },
      next,
    })

    const booksByGroupMember = {}
    rows.forEach(({ idpId, name, domain, ...book }) => {
      booksByGroupMember[idpId] = booksByGroupMember[idpId] || {
        idpId,
        name,
        domain,
        commonBooks: [],
      }
      booksByGroupMember[idpId].commonBooks.push(book)
    })
    const groupMembers = Object.values(booksByGroupMember)

    log('Deliver common books from associated sites')
    res.send({ groupMembers })

  })

  // copy interactive tools to book on associated site
  app.post('/copytools', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to copy tools', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    if(!util.paramsOk(req.body, ['pasteIdpId', 'bookId'], ['clearExistingToolsFirst'])) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    const sourceClassroomUid = `${req.user.idpId}-${req.body.bookId}`
    const destinationClassroomId = `${req.body.pasteIdpId}-${req.body.bookId}`
    const now = util.timestampToMySQLDatetime()

    const toolRowsToCopy = await util.runQuery({
      query: `
        SELECT
          t.spineIdRef,
          t.cfi,
          t.ordering,
          t.name,
          t.toolType,
          t.data,
          t.isDiscussion,
          t.undo_array,
          t.due_at,
          t.closes_at,
          t.creatorType

        FROM tool AS t

        WHERE t.classroom_uid=:classroomUid
          AND t.published_at IS NOT NULL
          AND t.deleted_at IS NULL
          AND t.currently_published_tool_uid IS NULL
      `,
      vars: {
        classroomUid: sourceClassroomUid,
      },
      next,
    })

    const vars = {
      destinationClassroomId,
      now,
      defaultDestinationClassroom: {
        uid: destinationClassroomId,
        idp_id: req.body.pasteIdpId,
        book_id: req.body.bookId,
        created_at: now,
        updated_at: now,
      },
    }

    toolRowsToCopy.forEach((tool, idx) => {
      tool.uid = uuidv4()
      tool.classroom_uid = destinationClassroomId
      tool.created_at = now
      tool.updated_at = now
      tool.published_at = now
      vars[`tool_insert_${idx}`] = tool
    })

    const queries = [

      `START TRANSACTION`,

      ...(!req.body.clearExistingToolsFirst ? [] : [`
        UPDATE tool
        SET deleted_at=:now
        WHERE classroom_uid=:destinationClassroomId
          AND deleted_at IS NULL
      `]),

      `INSERT IGNORE INTO classroom SET :defaultDestinationClassroom`,

      ...toolRowsToCopy.map((tool, idx) => `INSERT INTO tool SET :tool_insert_${idx}`),

      `COMMIT`,

    ]

    await util.runQuery({
      queries,
      vars,
      next,
    })

    log(`Copy tools (from classroom ${sourceClassroomUid} to ${destinationClassroomId}) was successful`+(req.body.clearExistingToolsFirst ? ` (after existing ${destinationClassroomId} tools were deleted)` : ``))
    res.send({ success: true, numToolsCopied: toolRowsToCopy.length })

  })

  // user search
  app.get('/userinfo', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to search users', 3)
      res.status(403).send({ errorType: "no_permission" })
      return
    }

    const [ user ] = await util.runQuery({
      query: `
        SELECT u.*
        FROM user AS u
        WHERE u.id = :id
          AND u.idp_id = :idpId
      `,
      vars: {
        id: req.query.userId,
        idpId: req.user.idpId,
      },
      next,
    })

    if(user) {

      const [ subscriptionInstances, books, interactiveActivity ] = await util.runQuery({
        queries: [
          `
            SELECT s.label, si.first_given_access_at, si.expires_at, si.enhanced_tools_expire_at
            FROM subscription_instance AS si
              LEFT JOIN subscription AS s ON (s.id = si.subscription_id)
            WHERE si.user_id = :userId
              AND s.deleted_at IS NULL
            ORDER BY s.label
          `,
          `
            SELECT b.id, b.title, b.author, cba.version, cba.expires_at, cba.enhanced_tools_expire_at, cba.flags, ll.cfi
            FROM computed_book_access AS cba
              LEFT JOIN book AS b ON (b.id = cba.book_id)
              LEFT JOIN \`book-idp\` AS bi ON (cba.book_id = bi.book_id)
              LEFT JOIN latest_location AS ll ON (cba.book_id = ll.book_id AND ll.user_id = cba.user_id)
            WHERE cba.user_id = :userId
              AND bi.idp_id = :idpId
            ORDER BY b.title, b.author, b.id
          `,
          `
            SELECT te.uid, te.text, te.updated_at, te.submitted_at, te.score,
              t.name, t.toolType, t.isDiscussion, t.creatorType, t.spineIdRef, t.cfi, t.currently_published_tool_uid, 
              c.name AS classroom_name, c.deleted_at AS classroom_deleted_at,
              b.id AS book_id, b.title, b.author
            FROM tool_engagement AS te
              LEFT JOIN tool AS t ON (t.uid = te.tool_uid)
              LEFT JOIN classroom AS c ON (c.uid = t.classroom_uid)
              LEFT JOIN book AS b ON (b.id = c.book_id)
            WHERE te.user_id = :userId
              AND te.deleted_at IS NULL
              AND t.toolType IN ('QUIZ','QUESTION','POLL','SKETCH')
            ORDER BY te.updated_at DESC
            LIMIT :limit
          `,
        ],
        vars: {
          userId: user.id,
          idpId: req.user.idpId,
          limit: parseInt(req.query.limit || 3),
        },
        next,
      })

      util.convertJsonColsFromStrings({ tableName: 'computed_book_access', rows: books })

      util.convertMySQLDatetimesToTimestamps(user)
      util.convertMySQLDatetimesToTimestamps(subscriptionInstances)
      util.convertMySQLDatetimesToTimestamps(books)
      util.convertMySQLDatetimesToTimestamps(interactiveActivity)

      user.subscriptionInstances = subscriptionInstances
      user.books = books
      user.interactiveActivity = interactiveActivity

    }

    log('Deliver user info results')
    res.send(user)

  })

}