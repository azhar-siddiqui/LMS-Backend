import { Request, Response, NextFunction } from "express";
import cloudinary from "cloudinary";
import userModel, { IUser } from "../models/user.model";
import ErrorHandler from "../utils/ErrorHandler";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import jwt, { JwtPayload, Secret } from "jsonwebtoken";
import ejs from "ejs";
import path from "path";
require("dotenv").config();

import sendEmail from "../utils/SendEmail";
import {
  accessTokenOptions,
  refreshTokenOptions,
  sendToken,
} from "../utils/jwt";
import { redis } from "../utils/radis";
import { getUserById } from "../services/user.service";

// register User
interface IRegistrationBody {
  name: string;
  email: string;
  password: string;
  avatar?: string;
}

export const registrationUser = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const { name, email, password } = req.body;

      const isEmailExist = await userModel.findOne({ email });
      if (isEmailExist) {
        return next(new ErrorHandler("Email already exist", 400));
      }

      const user: IRegistrationBody = {
        name,
        email,
        password,
      };

      const activationToken = createActivationToken(user);

      const activationCode = activationToken.activationCode;

      const data = { user: { name: user.name }, activationCode };

      const html = await ejs.renderFile(
        path.join(__dirname, "../mails/activationMail.ejs"),
        data
      );

      try {
        await sendEmail({
          email: user.email,
          subject: "Please Activate Your Account",
          template: "activationMail.ejs",
          data,
        });

        resp.status(201).json({
          success: true,
          message: `Please check your email ${user.email} to activate your account!`,
          activationToken: activationToken.token,
        });
      } catch (error: any) {
        return next(new ErrorHandler(error.message, 400));
      }
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

interface IActivationToken {
  token: string;
  activationCode: string;
}

const ACTIVATION_SECRET = process.env.ACTIVATION_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

export const createActivationToken = (user: any): IActivationToken => {
  const activationCode = Math.floor(1000 + Math.random() * 9000).toString();

  const token = jwt.sign(
    { user, activationCode },
    ACTIVATION_SECRET as Secret,
    { expiresIn: "5m" }
  );

  return { token, activationCode };
};

// Activate User
interface IActivationRequest {
  activationToken: string;
  activationCode: string;
}

export const activateUser = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const { activationToken, activationCode } =
        req.body as IActivationRequest;

      const newUser: { user: IUser; activationCode: string } = jwt.verify(
        activationToken,
        process.env.ACTIVATION_SECRET as string
      ) as { user: IUser; activationCode: string };

      if (newUser.activationCode !== activationCode) {
        return next(new ErrorHandler("Invalid activation code", 400));
      }

      const { name, email, password } = newUser.user;

      const existUser = await userModel.findOne({ email });

      if (existUser) {
        return next(new ErrorHandler("Email all ready exist ", 400));
      }

      const user = await userModel.create({ name, email, password });

      resp.status(201).json({
        success: true,
        user,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

interface ILoginRequest {
  email: string;
  password: string;
}

// login user
export const loginUser = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as ILoginRequest;

      if (!email || !password) {
        return next(new ErrorHandler("Please Enter Email and Password", 400));
      }

      const user = await userModel.findOne({ email }).select("+password");

      if (!user) {
        return next(new ErrorHandler("Invalid User", 400));
      }

      const isPasswordMatch = await user.comparePassword(password);

      if (!isPasswordMatch) {
        return next(new ErrorHandler("Please enter correct password", 400));
      }
      sendToken(user, 200, resp);
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// logout user
export const logoutUser = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      resp.cookie("accessToken", "", { maxAge: 1 });
      resp.cookie("refreshToken", "", { maxAge: 1 });

      const userId = req.user?._id || "";

      redis.del(userId);

      resp
        .status(200)
        .json({ success: true, message: "Logged out successfully" });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// update access token
export const updateAccessToken = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const refresh_token = req.cookies.refreshToken as string;

      if (!refresh_token) {
        return next(new ErrorHandler("Please pass refresh token", 400));
      }

      const decode = jwt.verify(
        refresh_token,
        REFRESH_TOKEN as string
      ) as JwtPayload;

      const message = "Could not refresh token";
      if (!decode) {
        return next(new ErrorHandler(message, 400));
      }

      const session = await redis.get(decode.id as string);

      if (!session) {
        return next(new ErrorHandler(message, 400));
      }

      const user = JSON.parse(session);

      const accessToken = jwt.sign({ id: user._id }, ACCESS_TOKEN as string, {
        expiresIn: "5m",
      });

      const refreshToken = jwt.sign({ id: user._id }, REFRESH_TOKEN as string, {
        expiresIn: "3d",
      });

      req.user = user;

      resp.cookie("accessToken", accessToken, accessTokenOptions);
      resp.cookie("refreshToken", refreshToken, refreshTokenOptions);

      resp.status(200).json({
        status: "success",
        accessToken,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// get user Info
export const getUserInfo = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      getUserById(userId, resp);
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

interface ISocialAuthBody {
  email: string;
  name: string;
  avatar: string;
}

// social auth
export const socialAuth = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const { email, name, avatar } = req.body as ISocialAuthBody;
      const user = await userModel.findOne({ email });
      if (!user) {
        const newUser = await userModel.create({ email, name, avatar });
        sendToken(newUser, 201, resp);
      } else {
        sendToken(user, 200, resp);
      }
    } catch (error: any) {
      return next(new ErrorHandler(error, 400));
    }
  }
);

// update user Info
interface IUpdateUserInfo {
  name?: string;
  email?: string;
  // password?: string;
}

export const updateUserInfo = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const { name, email } = req.body as IUpdateUserInfo;
      const userId = req.user?._id;

      const user = await userModel.findByIdAndUpdate(userId);

      if (email && user) {
        const isEmailExist = await userModel.findOne({ email });
        if (isEmailExist) {
          return next(new ErrorHandler("Email all ready Exist", 400));
        }
        user.email = email;
      }

      if (name && user) {
        user.name = name;
      }

      await user?.save();

      await redis.set(userId, JSON.stringify(user));

      resp.status(202).json({ status: true, user });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

// update user password
interface IUpdatePassword {
  oldPassword: string;
  newPassword: string;
}

export const updatePassword = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const { oldPassword, newPassword } = req.body as IUpdatePassword;

      if (!oldPassword || !newPassword) {
        return next(new ErrorHandler("Please Enter old and new password", 400));
      }

      const user = await userModel.findById(req.user?._id).select("+password");

      if (oldPassword === newPassword) {
        return next(new ErrorHandler("Please Enter New Password", 400));
      }

      if (user?.password === undefined) {
        return next(new ErrorHandler("Invalid User", 400));
      }

      const isPasswordMatch = await user?.comparePassword(oldPassword);

      if (!isPasswordMatch) {
        return next(new ErrorHandler("Please enter correct password", 400));
      }

      user.password = newPassword;

      await user.save();

      await redis.set(req.user?._id, JSON.stringify(user));

      const { _id, name, email, role, isVerified } = user;

      resp.status(200).json({
        success: true,
        message: "Password Updated Successfully",
        user: { _id, name, email, role, isVerified },
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);

interface IUpdateProfilePicture {
  avatar: string;
}
// update profile picture
export const updateProfilePicture = catchAsyncError(
  async (req: Request, resp: Response, next: NextFunction) => {
    try {
      const { avatar } = req.body as IUpdateProfilePicture;

      const userId = req.user?._id;

      const user = await userModel.findById(userId);

      if (avatar && user) {
        // if user have one avatar then call this
        if (user?.avatar?.public_id) {
          // first delete an old profile
          await cloudinary.v2.uploader.destroy(user?.avatar?.public_id);

          const myCloud = await cloudinary.v2.uploader.upload(avatar, {
            folder: "avatars",
            width: 150,
          });

          user.avatar = {
            public_id: myCloud.public_id,
            url: myCloud.secure_url,
          };
        } else {
          const myCloud = await cloudinary.v2.uploader.upload(avatar, {
            folder: "avatars",
            width: 150,
          });
          user.avatar = {
            public_id: myCloud.public_id,
            url: myCloud.secure_url,
          };
        }
      }

      await user?.save();
      await redis.set(userId, JSON.stringify(user));

      resp
        .status(200)
        .json({ status: true, message: "Profile Uploaded", user });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);
