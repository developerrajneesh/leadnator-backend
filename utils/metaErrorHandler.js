/**
 * Utility functions for handling Meta API errors
 */

/**
 * Check if an error is a token expiration error
 * @param {Object} error - The error object from Meta API
 * @returns {boolean} - True if the error indicates token expiration
 */
function isTokenExpiredError(error) {
  if (!error) return false;
  
  const fbError = error.fb || error.error || error;
  
  // Check for OAuthException with code 190 and error_subcode 463 (session expired)
  return (
    fbError.code === 190 &&
    fbError.error_subcode === 463 &&
    (fbError.type === "OAuthException" || fbError.type === "OAuthException")
  );
}

/**
 * Check if an error response indicates token expiration
 * @param {Object} response - The axios response object
 * @returns {boolean} - True if the response indicates token expiration
 */
function isTokenExpiredResponse(response) {
  if (!response || !response.data) return false;
  
  const error = response.data.error || response.data;
  return isTokenExpiredError(error);
}

/**
 * Create a standardized token expiration error
 * @param {Object} originalError - The original error from Meta API
 * @returns {Error} - A standardized error with token expiration flag
 */
function createTokenExpiredError(originalError) {
  const error = new Error("Facebook access token has expired. Please reconnect your account.");
  error.status = 401;
  error.code = "TOKEN_EXPIRED";
  error.fb = originalError.fb || originalError.error || originalError;
  error.isTokenExpired = true;
  return error;
}

module.exports = {
  isTokenExpiredError,
  isTokenExpiredResponse,
  createTokenExpiredError,
};

