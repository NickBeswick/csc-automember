import mssql from 'mssql';

const connStr = process.env.AZURE_SQL_CONN;

let _pool;
export async function sqlPool() {
  if (_pool) return _pool;
  if (!connStr) throw new Error('AZURE_SQL_CONN missing');
  _pool = await mssql.connect(connStr);
  return _pool;
}

export async function findCandidates({ FirstName, LastName, Email, Phone, DOB }) {
  const pool = await sqlPool();
  // Basic matching using Customers + latest CustomerLoyaltyCards
  const request = pool.request();
  request.input('FirstName', mssql.NVarChar, FirstName || null);
  request.input('LastName',  mssql.NVarChar, LastName  || null);
  request.input('Email',     mssql.NVarChar, Email     || null);
  request.input('Phone',     mssql.NVarChar, Phone     || null);
  request.input('DOB',       mssql.Date,     DOB       || null);

  const query = `
    ;WITH LatestCard AS (
      SELECT clc.CustomerID, clc.CardNo, clc.DTExpiry, clc.DTCreated,
             ROW_NUMBER() OVER (PARTITION BY clc.CustomerID ORDER BY clc.DTExpiry DESC, clc.DTCreated DESC) rn
      FROM dbo.CustomerLoyaltyCards clc
    )
    SELECT TOP (5)
      cu.CustomerID,
      lc.CardNo AS MemberNumber,
      cu.FirstName, cu.Surname AS LastName,
      cu.Email, cu.TelNo, cu.Mobile, cu.Birthday AS DOB,
      lc.DTExpiry AS ExpiryDate
    FROM dbo.Customers cu
    LEFT JOIN LatestCard lc ON lc.CustomerID = cu.CustomerID AND lc.rn = 1
    WHERE
      (
        (@Email IS NOT NULL AND LOWER(LTRIM(RTRIM(cu.Email))) = LOWER(LTRIM(RTRIM(@Email))))
        OR (@Phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(ISNULL(cu.Mobile, cu.TelNo),'+',''),' ','') ,'-','')
             = REPLACE(REPLACE(REPLACE(@Phone,'+',''),' ','') ,'-',''))
        OR (@DOB IS NOT NULL AND cu.Birthday = @DOB)
        OR (cu.FirstName = @FirstName AND cu.Surname = @LastName)
      )
    ORDER BY
      CASE WHEN @Email IS NOT NULL AND LOWER(LTRIM(RTRIM(cu.Email))) = LOWER(LTRIM(RTRIM(@Email))) THEN 1 ELSE 2 END,
      cu.CustomerID ASC;
  `;
  const rs = await request.query(query);
  return rs.recordset || [];
}

export async function approveRenewal({ customerID, providedCardNo }) {
  const pool = await sqlPool();
  const request = pool.request();
  request.input('CustomerID', mssql.Int, customerID);
  request.input('ProvidedCardNo', mssql.NVarChar, (providedCardNo || '').trim() || null);

  // compute dates in SQL to keep rules in one place
  const result = await request.query(`
    DECLARE @Today date = CONVERT(date, SYSUTCDATETIME());
    DECLARE @CurrentExpiry date = (
      SELECT TOP(1) CONVERT(date, DTExpiry)
      FROM dbo.CustomerLoyaltyCards WITH (UPDLOCK, ROWLOCK)
      WHERE CustomerID = @CustomerID AND (IsRevoked = 0 OR IsRevoked IS NULL)
      ORDER BY DTExpiry DESC, DTCreated DESC
    );

    DECLARE @StartDate date, @EndDate date;
    IF @CurrentExpiry IS NOT NULL AND @CurrentExpiry >= @Today
    BEGIN
      SET @StartDate = DATEADD(DAY,1,@CurrentExpiry);
      SET @EndDate   = DATEADD(MONTH,12,@CurrentExpiry);
    END
    ELSE
    BEGIN
      SET @StartDate = @Today;
      SET @EndDate   = DATEADD(MONTH,12,@StartDate);
    END

    DECLARE @CardNo nvarchar(50) = @ProvidedCardNo;
    IF (@CardNo IS NULL OR LTRIM(RTRIM(@CardNo)) = '')
    BEGIN
      -- generate a safe fallback: CSC-YYYY-<random 6>
      SET @CardNo = CONCAT('CSC-', FORMAT(SYSUTCDATETIME(), 'yyyy'), '-', RIGHT(ABS(CHECKSUM(NEWID())), 6));
      WHILE EXISTS (SELECT 1 FROM dbo.CustomerLoyaltyCards WHERE CardNo = @CardNo)
      BEGIN
        SET @CardNo = CONCAT('CSC-', FORMAT(SYSUTCDATETIME(), 'yyyy'), '-', RIGHT(ABS(CHECKSUM(NEWID())), 6));
      END
    END
    ELSE
    BEGIN
      IF EXISTS (SELECT 1 FROM dbo.CustomerLoyaltyCards WHERE CardNo = @CardNo)
        THROW 51001, 'Provided CardNo already exists', 1;
    END

    INSERT INTO dbo.CustomerLoyaltyCards
      (CustomerID, CardNo, DTExpiry, DTRevoked, IsActive, IsRevoked, DTCreated, DTUpdated)
    VALUES
      (@CustomerID, @CardNo, DATEADD(SECOND,-1,DATEADD(DAY,1,@EndDate)), NULL, 1, 0, SYSUTCDATETIME(), SYSUTCDATETIME());

    SELECT @CustomerID AS CustomerID, @CardNo AS CardNo, CONVERT(date, @EndDate) AS NewExpiry;
  `);

  return result.recordset?.[0] || { customerID, cardNo: providedCardNo || null };
}

export async function createCustomerAndApprove({ first, last, email, phone, dob, providedCardNo }) {
  const pool = await sqlPool();
  const r1 = await pool.request()
    .input('First', mssql.NVarChar, first || '')
    .input('Last',  mssql.NVarChar, last  || '')
    .input('Email', mssql.NVarChar, email || null)
    .input('Phone', mssql.NVarChar, phone || null)
    .input('DOB',   mssql.Date,     dob   || null)
    .query(`
      INSERT INTO dbo.Customers
        (Title, FirstName, Surname, Address, City, County, PostCode,
         CountryCode, TelNo, Mobile, Email, IsActive, Balance, DTCreated, DTUpdated, Birthday)
      VALUES
        (NULL, @First, @Last, NULL, NULL, NULL, NULL,
         NULL, @Phone, @Phone, @Email, 1, 0, SYSUTCDATETIME(), SYSUTCDATETIME(), @DOB);

      SELECT SCOPE_IDENTITY() AS CustomerID;
    `);

  const customerID = r1.recordset?.[0]?.CustomerID;
  if (!customerID) throw new Error('Failed to insert customer');

  const out = await approveRenewal({ customerID, providedCardNo });
  return out;
}
